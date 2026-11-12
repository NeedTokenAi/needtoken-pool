import { readFileSync } from "node:fs";
import { REGISTRY_IMAGE_REF } from "./src/runtime.js";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const PG_DUMP_STATUS = "unverified";

const forbidden = [
  "wrangler deploy",
  "wrangler publish",
  "gcloud",
  "docker push",
  "git tag",
  "action-gh-release",
];

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

export function stripJsonc(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
}

export function assertDurableObjectPolicy(wranglerText, options = {}) {
  const config = JSON.parse(stripJsonc(wranglerText));
  const containers = config.containers ?? [];
  if (containers.length !== 1) {
    throw new Error("expected one container application");
  }
  const application = containers[0];
  if (application.scheduling_policy !== "durable_object") {
    throw new Error("scheduling_policy must be durable_object");
  }
  if (Object.prototype.hasOwnProperty.call(application, "max_instances")) {
    throw new Error("durable_object policy does not support max_instances");
  }
  if (application.instance_type === "basic" || application.instance_type === "default") {
    throw new Error("deprecated instance type");
  }
  if (application.scheduling_policy === "default" || !application.scheduling_policy) {
    throw new Error("default scheduling policy is deprecated");
  }
  const image = application.images?.pool ?? {};
  if (options.digestPinned) {
    assertStagingImageConfig(config, options.record);
  } else if (!image.dockerfile || !image.build_context) {
    throw new Error("pool image must name the existing Dockerfile");
  }
  return config;
}

export function assertStagingImageConfig(config, record) {
  const application = config.containers?.[0] ?? {};
  const image = application.images?.pool ?? {};
  if (image.dockerfile || image.build_context || application.image) {
    throw new Error("staging config must not rebuild the image at deploy time");
  }
  if (!record || record.recorded !== true) {
    if (image.image) {
      throw new Error("staging image must be the digest recorded by CI");
    }
    return;
  }
  if (typeof record.repository !== "string" || typeof record.sha !== "string" || typeof record.run_id !== "string") {
    throw new Error("CI image record must include repository, sha, and run id");
  }
  if (image.image !== record.digest || !REGISTRY_IMAGE_REF.test(record.digest ?? "") || record.digest.endsWith("0".repeat(64))) {
    throw new Error("staging image must be the digest recorded by CI");
  }
}

export function assertNoPublisher(texts) {
  for (const [name, text] of texts) {
    const lower = text.toLowerCase();
    for (const phrase of forbidden) {
      if (lower.includes(phrase)) {
        throw new Error(`${name} contains publisher command ${phrase}`);
      }
    }
  }
}

export const PINNED_ACTIONS = {
  checkout: "d23441a48e516b6c34aea4fa41551a30e30af803",
  setupNode: "249970729cb0ef3589644e2896645e5dc5ba9c38",
  setupGo: "924ae3a1cded613372ab5595356fb5720e22ba16",
};

const PLACEHOLDER_DIGEST = `sha256:${"0".repeat(64)}`;

export function assertCandidateWorkflow(workflowText) {
  if (/^\s*push\s*:/m.test(workflowText) || /^\s*tags\s*:/m.test(workflowText)) {
    throw new Error("candidate workflow must not run on push or v* tags");
  }
  if (!workflowText.includes("workflow_dispatch")) {
    throw new Error("candidate workflow must bind a dispatched main SHA and digest");
  }
  if (!workflowText.includes("contents: read")) {
    throw new Error("candidate workflow must stay read-only");
  }
  if (/uses:\s*actions\/[^\s@]+@v\d/.test(workflowText)) {
    throw new Error("actions must be pinned to commit SHAs");
  }
  for (const sha of Object.values(PINNED_ACTIONS)) {
    if (!workflowText.includes(sha)) {
      throw new Error(`candidate workflow is missing pinned action ${sha}`);
    }
  }
  if (!workflowText.includes("build_source_sha") || !workflowText.includes("--head")) {
    throw new Error("digest must be tied to the build source SHA");
  }
}

export function assertStagingImageWorkflow(workflowText) {
  if (!/^on:\n {2}workflow_dispatch:\n/.test(workflowText) && !workflowText.includes("workflow_dispatch:")) {
    throw new Error("staging image workflow must be workflow_dispatch only");
  }
  if (/^\s*push\s*:/m.test(workflowText) || /^\s*tags\s*:/m.test(workflowText) || /^\s*pull_request\s*:/m.test(workflowText)) {
    throw new Error("staging image workflow must not run on push, pull request, or tags");
  }
  if (!workflowText.includes("containers build") || !workflowText.includes("digest=")) {
    throw new Error("staging image workflow must build an image and output the digest");
  }
  if (workflowText.toLowerCase().includes("rollback is possible")) {
    throw new Error("rollback is not available");
  }
}

export function bindCandidate({ mainSha, digest, originMainSha, buildSourceSha, headSha, runId }) {
  if (!/^[0-9a-f]{40}$/.test(mainSha ?? "")) {
    throw new Error("main SHA must be 40 hex characters");
  }
  if (/^sha256:[0-9a-f]{64}$/.test(digest ?? "") || digest === PLACEHOLDER_DIGEST) {
    throw new Error("bare sha256 stays fail-closed");
  }
  if (!REGISTRY_IMAGE_REF.test(digest ?? "")) {
    throw new Error("digest must be a full registry ref");
  }
  if (!/^[1-9][0-9]+$/.test(runId ?? "")) {
    throw new Error("build run id is required");
  }
  if (!/^[0-9a-f]{40}$/.test(buildSourceSha ?? "")) {
    throw new Error("digest build source SHA is required");
  }
  if (buildSourceSha !== mainSha || headSha !== mainSha) {
    throw new Error("digest build source is not the checked out candidate SHA");
  }
  if (mainSha !== originMainSha) {
    throw new Error("candidate SHA is not origin/main");
  }
  return {
    mainSha,
    digest,
    buildSourceSha,
    runId,
    deployed: false,
    rollback: false,
    authorizesBoot: false,
    pgDump: PG_DUMP_STATUS,
  };
}

export function selfTest() {
  const wrangler = read("cloudflare/wrangler.jsonc");
  const workflow = read(".github/workflows/cloudflare-candidate.yml");
  const index = read("cloudflare/src/index.js");
  const runtime = read("cloudflare/src/runtime.js");
  const bindings = JSON.parse(read("cloudflare/secret-bindings.json"));
  assertDurableObjectPolicy(wrangler);
  assertCandidateWorkflow(workflow);
  assertNoPublisher([
    ["wrangler.jsonc", wrangler],
    ["cloudflare-candidate.yml", workflow],
    ["index.js", index],
    ["runtime.js", runtime],
    ["secret-bindings.json", JSON.stringify(bindings)],
  ]);
  if (!runtime.includes("scheduling_policy") && wrangler.includes('"default"')) {
    throw new Error("default scheduling policy must not be selected");
  }
  if (wrangler.includes("max_instances")) {
    throw new Error("max_instances is not valid for this policy");
  }
  if (bindings.scope !== "isolated" || bindings.stops_old_production !== false) {
    throw new Error("candidate allows isolated bindings only");
  }
  for (const binding of bindings.bindings) {
    if (!binding.name || !binding.container_env || binding.value) {
      throw new Error("secret bindings are names only");
    }
  }
  if (!index.includes("singletonName") || !index.includes("getByName") || !index.includes("approved: gate.approved")) {
    throw new Error("worker must route one code-enforced singleton");
  }
  const staging = read("cloudflare/wrangler.staging.jsonc");
  const record = JSON.parse(read("cloudflare/staging-image-record.json"));
  const stagingConfig = assertDurableObjectPolicy(staging, { digestPinned: true, record });
  if (stagingConfig.name !== "needtoken-pool-staging") {
    throw new Error("staging worker name must use the -staging suffix");
  }
  if (stagingConfig.routes || stagingConfig.route || stagingConfig.workers_dev !== false) {
    throw new Error("staging config must not publish a production route");
  }
  if (!staging.includes("CONFIG_FILE") || !staging.includes("DATA_DIR") || !staging.includes("STAGING_TEST_JWT_SECRET")) {
    throw new Error("staging config must pass CONFIG_FILE, DATA_DIR, and the test JWT");
  }
  assertNoPublisher([
    ["wrangler.staging.jsonc", staging],
  ]);
  if (workflow.toLowerCase().includes("rollback is possible")) {
    throw new Error("rollback is not available");
  }
  return { pgDump: PG_DUMP_STATUS, deployed: false, rollback: false };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    throw new Error(`missing ${name}`);
  }
  return process.argv[index + 1];
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (process.argv.includes("--self-test")) {
    const result = selfTest();
    console.log(`candidate self-test ok deployed=${result.deployed} pg_dump=${result.pgDump}`);
  } else if (process.argv.includes("--bind")) {
    const bound = bindCandidate({
      mainSha: argument("--main-sha"),
      digest: argument("--digest"),
      originMainSha: argument("--origin-main"),
      buildSourceSha: argument("--build-source-sha"),
      headSha: argument("--head"),
      runId: argument("--run-id"),
    });
    console.log(`bound ${bound.mainSha} ${bound.digest} deployed=${bound.deployed} rollback=${bound.rollback} pg_dump=${bound.pgDump}`);
  } else {
    throw new Error("use --self-test or --bind");
  }
}
