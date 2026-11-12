import { readFileSync } from "node:fs";
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

export function assertDurableObjectPolicy(wranglerText) {
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
  const image = application.images?.pool;
  if (!image?.dockerfile || !image?.build_context) {
    throw new Error("pool image must name the existing Dockerfile");
  }
  return config;
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
}

export function bindCandidate({ mainSha, digest, originMainSha }) {
  if (!/^[0-9a-f]{40}$/.test(mainSha ?? "")) {
    throw new Error("main SHA must be 40 hex characters");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? "")) {
    throw new Error("image digest must be sha256 and 64 hex characters");
  }
  if (mainSha !== originMainSha) {
    throw new Error("candidate SHA is not origin/main");
  }
  return {
    mainSha,
    digest,
    deployed: false,
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
  for (const binding of bindings.bindings) {
    if (!binding.name || !binding.container_env || binding.value) {
      throw new Error("secret bindings are names only");
    }
  }
  if (!index.includes("singletonName") || !index.includes("idFromName")) {
    throw new Error("worker must route one code-enforced singleton");
  }
  return { pgDump: PG_DUMP_STATUS, deployed: false };
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
    });
    console.log(`bound ${bound.mainSha} ${bound.digest} deployed=${bound.deployed} pg_dump=${bound.pgDump}`);
  } else {
    throw new Error("use --self-test or --bind");
  }
}
