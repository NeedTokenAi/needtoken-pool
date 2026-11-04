import importlib.util
import json
import os
import re
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = Path(__file__).with_name("needtoken_ops.py")
spec = importlib.util.spec_from_file_location("needtoken_ops", SCRIPT)
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)

SHA_A = "a" * 40
SHA_B = "b" * 40
SHA_C = "c" * 40
DIGEST = "d" * 64
IMAGE = (
    "asia-southeast1-docker.pkg.dev/suichong/needtoken-pool/"
    f"needtoken-pool@sha256:{DIGEST}"
)
OLD_IMAGE = (
    "asia-southeast1-docker.pkg.dev/suichong/needtoken-pool/"
    f"needtoken-pool@sha256:{'e' * 64}"
)
SECRET = "super-secret-value"
SERVICE_URL = "https://needtoken-pool-iipumltoca-as.a.run.app"
CANDIDATE_URL = "https://candidate---needtoken-pool-iipumltoca-as.a.run.app"
WIF = (
    "projects/123456789/locations/global/workloadIdentityPools/"
    "needtoken/providers/github"
)
DEPLOYER = "github-needtoken-pool-deploy@suichong.iam.gserviceaccount.com"


def run(command, cwd, env=None, check=True):
    completed = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if check and completed.returncode != 0:
        raise AssertionError(f"{command} failed\n{completed.stdout}")
    return completed


class DecisionTests(unittest.TestCase):
    def test_required_checks_reject_a_missing_or_failed_job(self):
        needs = {name: {"result": "success"} for name in ops.REQUIRED_CHECK_JOBS}
        ops.assert_required_checks(needs)
        broken = dict(needs)
        broken["ops-infra"] = {"result": "failure"}
        with self.assertRaises(ops.OpsError):
            ops.assert_required_checks(broken)
        del broken["ops-infra"]
        with self.assertRaises(ops.OpsError):
            ops.assert_required_checks(broken)

    def test_ci_workflow_lists_every_job_in_the_gate(self):
        text = (ROOT / ".github/workflows/backend-ci.yml").read_text(encoding="utf-8")
        jobs = text.split("\njobs:\n", 1)[1]
        job_ids = re.findall(r"^  ([A-Za-z0-9_-]+):\s*$", jobs, re.M)
        self.assertIn(ops.GATE_JOB, job_ids)
        match = re.search(
            r"^  required-checks:\n(?:    .*\n)*?    needs:\s*\[([^\]]+)\]",
            text,
            re.M,
        )
        self.assertIsNotNone(match)
        listed = [part.strip() for part in match.group(1).split(",")]
        self.assertEqual(listed, list(ops.REQUIRED_CHECK_JOBS))
        self.assertEqual(set(job_ids) - {ops.GATE_JOB}, set(ops.REQUIRED_CHECK_JOBS))
        self.assertIn("if: always()", text)

    def test_deploy_gate_accepts_only_current_main_push_ci(self):
        accepted = ops.deploy_gate(
            {
                "event_name": "workflow_run",
                "repository": ops.ORIGIN_REPO,
                "workflow_name": "CI",
                "run_event": "push",
                "conclusion": "success",
                "head_branch": "main",
                "head_sha": SHA_A,
                "head_repository": ops.ORIGIN_REPO,
                "main_sha": SHA_A,
            }
        )
        self.assertEqual(accepted["deploy"], "true")
        self.assertEqual(accepted["sha"], SHA_A)

        stale = dict(accepted={"unused": True})
        stale = ops.deploy_gate(
            {
                "event_name": "workflow_run",
                "repository": ops.ORIGIN_REPO,
                "workflow_name": "CI",
                "run_event": "push",
                "conclusion": "success",
                "head_branch": "main",
                "head_sha": SHA_A,
                "head_repository": ops.ORIGIN_REPO,
                "main_sha": SHA_B,
            }
        )
        self.assertEqual(stale["reason"], "stale")
        for mutated, reason in (
            ({"run_event": "pull_request"}, "CI run was not a push"),
            ({"head_repository": "example/fork"}, "CI head repository is not this repository"),
            ({"conclusion": "failure"}, "CI conclusion was not success"),
            ({"head_branch": "feature"}, "CI run was not on main"),
            ({"repository": "example/elsewhere"}, "repository is example/elsewhere"),
            ({"serving_sha": SHA_A}, "duplicate"),
        ):
            event = {
                "event_name": "workflow_run",
                "repository": ops.ORIGIN_REPO,
                "workflow_name": "CI",
                "run_event": "push",
                "conclusion": "success",
                "head_branch": "main",
                "head_sha": SHA_A,
                "head_repository": ops.ORIGIN_REPO,
                "main_sha": SHA_A,
            }
            event.update(mutated)
            self.assertEqual(ops.deploy_gate(event)["reason"], reason)

    def test_manual_dispatch_requires_a_sha_on_main(self):
        accepted = ops.deploy_gate(
            {
                "event_name": "workflow_dispatch",
                "repository": ops.ORIGIN_REPO,
                "ref": "refs/heads/main",
                "input_sha": SHA_B.upper(),
                "on_main": "true",
            }
        )
        self.assertEqual(accepted["sha"], SHA_B)
        rejected = ops.deploy_gate(
            {
                "event_name": "workflow_dispatch",
                "repository": ops.ORIGIN_REPO,
                "ref": "refs/heads/feature",
                "input_sha": SHA_B,
                "on_main": "true",
            }
        )
        self.assertEqual(rejected["deploy"], "false")
        missing = ops.deploy_gate(
            {
                "event_name": "workflow_dispatch",
                "repository": ops.ORIGIN_REPO,
                "ref": "refs/heads/main",
                "input_sha": SHA_B,
                "on_main": "false",
            }
        )
        self.assertEqual(missing["reason"], "git_sha is not contained in main")

    def test_channel_resolution_is_a_single_ref(self):
        self.assertEqual(ops.parse_channel("release")["kind"], "release")
        self.assertEqual(ops.parse_channel("main")["git_ref"], "refs/heads/main")
        self.assertEqual(ops.parse_channel("v1.2.3")["git_ref"], "refs/tags/v1.2.3")
        for rejected in ("", "refs/tags/*", "main..evil", "refs/heads/feature/*"):
            with self.assertRaises(ops.OpsError):
                ops.parse_channel(rejected)

    def test_image_and_identity_rules(self):
        prefix = ops.image_repository(
            "asia-southeast1", "suichong", "needtoken-pool", "needtoken-pool"
        )
        self.assertEqual(ops.validate_image_ref(IMAGE, prefix), IMAGE)
        revision = ops.revision_name("needtoken-pool", SHA_A)
        self.assertEqual(revision, f"needtoken-pool-{SHA_A}")
        self.assertLessEqual(len(revision), 63)
        ops.validate_wif(WIF, DEPLOYER)
        for image in (
            prefix + ":latest",
            prefix + ":sha-" + SHA_A,
            "ghcr.io/wei-shaw/sub2api@sha256:" + DIGEST,
            "docker.io/library/sub2api:latest",
        ):
            with self.assertRaises(ops.OpsError):
                ops.validate_image_ref(image, prefix)
        with self.assertRaises(ops.OpsError):
            ops.validate_wif("{", DEPLOYER)
        with self.assertRaises(ops.OpsError):
            ops.validate_wif(WIF, '{"private_key":"secret"}')

    def test_runtime_diff_reports_paths_without_secret_values(self):
        before = service_doc(OLD_IMAGE, SHA_A, 100, False)
        after = json.loads(json.dumps(before))
        after["spec"]["template"]["spec"]["containers"][0]["image"] = IMAGE
        self.assertEqual(ops.runtime_diff_paths(before, after), [])
        after["spec"]["template"]["spec"]["containers"][0]["env"][1]["value"] = "rotated-secret"
        paths = ops.runtime_diff_paths(before, after)
        rendered = " ".join(paths)
        self.assertIn("/container/env/1/value", rendered)
        self.assertNotIn(SECRET, rendered)
        self.assertNotIn("rotated-secret", rendered)

    def test_sync_plan_keeps_one_pr_and_refuses_tag_pushes(self):
        open_prs = [
            {"number": 7, "headRefName": "sync/upstream/" + SHA_B, "url": "https://example/7"}
        ]
        blocked = ops.plan_sync(
            sha=SHA_A, contained=False, open_prs=open_prs, remote_branch_exists=False
        )
        self.assertEqual(blocked["action"], "skip-other-open")
        contained = ops.plan_sync(
            sha=SHA_A, contained=True, open_prs=[], remote_branch_exists=False
        )
        self.assertEqual(contained["action"], "skip-contained")
        create = ops.plan_sync(
            sha=SHA_A, contained=False, open_prs=[], remote_branch_exists=False
        )
        self.assertEqual(create["action"], "merge-and-create")
        self.assertEqual(
            ops.assert_branch_refspec(f"refs/heads/sync/upstream/{SHA_A}", SHA_A),
            f"refs/heads/sync/upstream/{SHA_A}",
        )
        with self.assertRaises(ops.OpsError):
            ops.assert_branch_refspec("refs/tags/v1.2.3", SHA_A)

    def test_reports_describe_merge_and_conflict_handling(self):
        body = ops.sync_pr_body(channel="main", label="main", sha=SHA_A, main_sha=SHA_B)
        self.assertIn("ordinary merge commit", body)
        self.assertIn("merge commit", body)
        self.assertIn("Squash and rebase", body)
        conflict = ops.conflict_issue_body(
            channel="main",
            label="main",
            sha=SHA_A,
            main_sha=SHA_B,
            files=["backend/go.mod"],
        )
        self.assertIn("Codex conflict report", conflict)
        self.assertIn("Conflict markers were not committed", conflict)
        self.assertIn("No sync branch was pushed", conflict)
        self.assertIn("backend/go.mod", conflict)

    def test_workflow_contracts(self):
        deploy = (ROOT / ".github/workflows/deploy-cloudrun.yml").read_text(encoding="utf-8")
        sync = (ROOT / ".github/workflows/sync-upstream.yml").read_text(encoding="utf-8")
        rollout = (ROOT / ".github/scripts/deploy-cloudrun.sh").read_text(encoding="utf-8")
        upstream = (ROOT / ".github/scripts/sync-upstream.sh").read_text(encoding="utf-8")
        self.assertIn('workflows: ["CI"]', deploy)
        self.assertIn("git_sha:", deploy)
        self.assertIn("cancel-in-progress: false", deploy)
        self.assertEqual(deploy.count("id-token:"), 1)
        self.assertNotIn("pull_request", deploy)
        self.assertNotIn(":latest", deploy)
        self.assertIn('cron: "0 0 * * *"', sync)
        self.assertNotIn("id-token", sync)
        self.assertNotIn("google-github-actions", sync)
        self.assertNotIn("gcloud", sync)
        self.assertNotIn("pull_request", sync)
        self.assertIn("--no-traffic", executable_lines(rollout))
        for forbidden in (
            "--set-env-vars",
            "--set-secrets",
            "--clear-env-vars",
            "--clear-secrets",
            "--to-latest",
            "services replace",
            "run deploy",
            ":latest",
        ):
            self.assertNotIn(forbidden, executable_lines(rollout))
        commands = [
            line.strip()
            for line in upstream.splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        push_at = [index for index, line in enumerate(commands) if line.startswith("push ")]
        self.assertEqual(len(push_at), 1)
        self.assertEqual(commands[push_at[0]], 'push "$remote" "HEAD:${ref}"')
        self.assertTrue(commands[push_at[0] - 1].startswith("git -c"))
        for line in executable_lines(upstream).splitlines():
            self.assertNotRegex(line, r"(^|\s)--tags(\s|$)")
            self.assertNotIn("--all", line)
        self.assertIn("--no-tags", upstream)
        self.assertIn("sync/upstream/", upstream)


class ShellFlowTests(unittest.TestCase):
    def test_gate_script_skips_stale_and_accepts_main(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = git_repo(Path(temp))
            sha = git_sha(repo)
            output = repo / "output.txt"
            accepted = run_gate(repo, output, head_sha=sha, run_event="push", conclusion="success")
            self.assertEqual(value(accepted, "deploy"), "true")
            self.assertEqual(value(accepted, "sha"), sha)
            rejected = run_gate(
                repo, output, head_sha=SHA_C, run_event="push", conclusion="success"
            )
            self.assertEqual(value(rejected, "deploy"), "false")
            self.assertEqual(value(rejected, "reason"), "stale")
            pr = run_gate(repo, output, head_sha=sha, run_event="pull_request", conclusion="success")
            self.assertEqual(value(pr, "reason"), "CI run was not a push")

    def test_preflight_skips_stale_without_calling_gcloud(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = git_repo(root)
            output = root / "output.txt"
            log = root / "gcloud.log"
            completed = run_rollout_tool(
                repo,
                "preflight",
                output,
                log,
                initial="before",
                extra_env={"EVENT_NAME": "workflow_run", "GIT_SHA": SHA_C},
            )
            self.assertEqual(completed.returncode, 0, completed.stdout)
            self.assertEqual(value(output.read_text(), "action"), "skip")
            self.assertEqual(value(output.read_text(), "reason"), "stale")
            self.assertFalse(log.exists())

    def test_rollout_promotes_only_after_smoke_and_preserves_env(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            log = root / "gcloud.log"
            completed = run_rollout_tool(
                root,
                "rollout",
                root / "output.txt",
                log,
                initial="before",
                extra_env={
                    "EVENT_NAME": "workflow_dispatch",
                    "GIT_SHA": SHA_A,
                    "ROLLOUT_MODE": "build",
                    "IMAGE": IMAGE,
                    "SMOKE_ATTEMPTS": "1",
                    "SMOKE_SLEEP": "0",
                },
            )
            self.assertEqual(completed.returncode, 0, completed.stdout)
            self.assertNotIn(SECRET, completed.stdout)
            commands = log.read_text(encoding="utf-8")
            self.assertIn("--no-traffic", commands)
            self.assertIn(f"--image {IMAGE}", commands)
            self.assertIn(f"--revision-suffix {SHA_A}", commands)
            self.assertIn(f"--to-revisions {ops.revision_name('needtoken-pool', SHA_A)}=100", commands)
            self.assertLess(
                commands.index("--no-traffic"),
                commands.index("--to-revisions"),
            )
            for forbidden in ("--set-env-vars", "--set-secrets", "--to-latest", "run deploy"):
                self.assertNotIn(forbidden, commands)

    def test_env_change_stops_before_traffic(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            log = root / "gcloud.log"
            completed = run_rollout_tool(
                root,
                "rollout",
                root / "output.txt",
                log,
                initial="before",
                break_env=True,
                extra_env={
                    "EVENT_NAME": "workflow_dispatch",
                    "GIT_SHA": SHA_A,
                    "ROLLOUT_MODE": "build",
                    "IMAGE": IMAGE,
                    "SMOKE_ATTEMPTS": "1",
                    "SMOKE_SLEEP": "0",
                },
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertNotIn(SECRET, completed.stdout)
            self.assertNotIn("rotated-secret", completed.stdout)
            self.assertNotIn("--to-revisions", log.read_text(encoding="utf-8"))

    def test_conflict_does_not_push_markers_and_clean_merge_has_two_parents(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            conflict = git_conflict_repo(root / "conflict")
            result = run_integrate(conflict["repo"], conflict["upstream"], root / "conflict-files.txt")
            self.assertEqual(result["rc"], 1, result["output"])
            self.assertEqual(result["pushes"], [])
            self.assertEqual(run(["git", "status", "--porcelain"], conflict["repo"]).stdout, "")
            self.assertNotIn("<<<<<<<", result["worktree"])
            self.assertIn("shared.txt", Path(result["conflict_file"]).read_text(encoding="utf-8"))

            clean = git_clean_repo(root / "clean")
            merged = run_integrate(clean["repo"], clean["upstream"])
            self.assertEqual(merged["rc"], 0, merged["output"])
            self.assertEqual(merged["pushes"], [clean["upstream"]])
            parents = run(
                ["git", "rev-list", "--parents", "-n", "1", "HEAD"], clean["repo"]
            ).stdout.split()
            self.assertEqual(len(parents), 3)

    def test_failed_push_is_not_reported_as_a_conflict(self):
        with tempfile.TemporaryDirectory() as temp:
            clean = git_clean_repo(Path(temp) / "clean")
            result = run_integrate(clean["repo"], clean["upstream"], push_status=1)
            self.assertEqual(result["rc"], 3, result["output"])
            self.assertEqual(result["pushes"], [])
            self.assertNotIn("<<<<<<<", result["worktree"])


def executable_lines(text):
    return "\n".join(
        line for line in text.splitlines() if line.strip() and not line.strip().startswith("#")
    )


def value(text, key):
    found = ""
    for line in text.splitlines():
        if line.startswith(key + "="):
            found = line.split("=", 1)[1]
    return found


def git_repo(root: Path) -> Path:
    repo = root / "repo"
    repo.mkdir()
    run(["git", "init", "-b", "main"], repo)
    run(["git", "config", "user.email", "test@example.com"], repo)
    run(["git", "config", "user.name", "test"], repo)
    (repo / "README").write_text("base\n", encoding="utf-8")
    run(["git", "add", "README"], repo)
    run(["git", "commit", "-m", "base"], repo)
    bare = root / "origin.git"
    run(["git", "init", "--bare", "-b", "main", str(bare)], root)
    run(["git", "remote", "add", "origin", str(bare)], repo)
    run(["git", "push", "-u", "origin", "main"], repo)
    return repo


def git_sha(repo: Path) -> str:
    return run(["git", "rev-parse", "HEAD"], repo).stdout.strip()


def run_gate(repo, output, head_sha, run_event, conclusion):
    output.write_text("", encoding="utf-8")
    env = os.environ.copy()
    env.update(
        {
            "GITHUB_OUTPUT": str(output),
            "GITHUB_STEP_SUMMARY": str(output) + ".summary",
            "EVENT_NAME": "workflow_run",
            "REPOSITORY": ops.ORIGIN_REPO,
            "WORKFLOW_NAME": "CI",
            "RUN_EVENT": run_event,
            "CONCLUSION": conclusion,
            "HEAD_BRANCH": "main",
            "HEAD_SHA": head_sha,
            "HEAD_REPOSITORY": ops.ORIGIN_REPO,
            "REF": "refs/heads/main",
            "INPUT_SHA": "",
        }
    )
    completed = run(
        ["bash", str(ROOT / ".github/scripts/deploy-cloudrun.sh"), "gate"],
        repo,
        env=env,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(completed.stdout)
    return output.read_text(encoding="utf-8")


def run_rollout_tool(root, command, output, log, initial, extra_env, break_env=False):
    fake_bin = root / "bin"
    fake_bin.mkdir()
    state = root / "state.json"
    state.write_text(
        json.dumps({"phase": initial, "tag": False, "break_env": break_env}),
        encoding="utf-8",
    )
    (fake_bin / "gcloud").write_text(FAKE_GCLOUD, encoding="utf-8")
    (fake_bin / "curl").write_text(FAKE_CURL, encoding="utf-8")
    os.chmod(fake_bin / "gcloud", 0o755)
    os.chmod(fake_bin / "curl", 0o755)
    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{fake_bin}{os.pathsep}{env['PATH']}",
            "FAKE_STATE": str(state),
            "FAKE_LOG": str(log),
            "FAKE_SHA": SHA_A,
            "FAKE_IMAGE": IMAGE,
            "FAKE_OLD_IMAGE": OLD_IMAGE,
            "FAKE_SECRET": SECRET,
            "GITHUB_OUTPUT": str(output),
            "GITHUB_STEP_SUMMARY": str(root / "summary.md"),
            "GCP_PROJECT_ID": "suichong",
            "GCP_REGION": "asia-southeast1",
            "CLOUD_RUN_SERVICE": "needtoken-pool",
            "ARTIFACT_REGISTRY_REPOSITORY": "needtoken-pool",
        }
    )
    env.update(extra_env)
    return run(
        ["bash", str(ROOT / ".github/scripts/deploy-cloudrun.sh"), command],
        root if command == "rollout" else root / "repo" if (root / "repo").exists() else root,
        env=env,
        check=False,
    )


def git_conflict_repo(repo: Path):
    repo.mkdir()
    run(["git", "init", "-b", "main"], repo)
    run(["git", "config", "user.email", "test@example.com"], repo)
    run(["git", "config", "user.name", "test"], repo)
    (repo / "shared.txt").write_text("base\n", encoding="utf-8")
    run(["git", "add", "shared.txt"], repo)
    run(["git", "commit", "-m", "base"], repo)
    base = git_sha(repo)
    run(["git", "checkout", "-b", "upstream"], repo)
    (repo / "shared.txt").write_text("upstream\n", encoding="utf-8")
    run(["git", "commit", "-am", "upstream"], repo)
    upstream = git_sha(repo)
    run(["git", "checkout", "main"], repo)
    (repo / "shared.txt").write_text("local\n", encoding="utf-8")
    run(["git", "commit", "-am", "local"], repo)
    return {"repo": repo, "base": base, "upstream": upstream}


def git_clean_repo(repo: Path):
    repo.mkdir()
    run(["git", "init", "-b", "main"], repo)
    run(["git", "config", "user.email", "test@example.com"], repo)
    run(["git", "config", "user.name", "test"], repo)
    (repo / "README").write_text("base\n", encoding="utf-8")
    run(["git", "add", "README"], repo)
    run(["git", "commit", "-m", "base"], repo)
    run(["git", "checkout", "-b", "upstream"], repo)
    (repo / "upstream.txt").write_text("upstream\n", encoding="utf-8")
    run(["git", "add", "upstream.txt"], repo)
    run(["git", "commit", "-m", "upstream"], repo)
    upstream = git_sha(repo)
    run(["git", "checkout", "main"], repo)
    (repo / "local.txt").write_text("local\n", encoding="utf-8")
    run(["git", "add", "local.txt"], repo)
    run(["git", "commit", "-m", "local"], repo)
    return {"repo": repo, "upstream": upstream}


def run_integrate(repo: Path, upstream: str, conflict_file: Path | None = None, push_status=0):
    conflict_file = conflict_file or (repo.parent / f"{repo.name}-conflicts.txt")
    push_log = repo.parent / f"{repo.name}-pushes.txt"
    script = textwrap.dedent(
        f"""
        set -euo pipefail
        source "{ROOT / '.github/scripts/sync-upstream.sh'}"
        push_sync_branch() {{
          GIT_SHA="$1" PUSH_REF="refs/heads/sync/upstream/$1" python3 "{SCRIPT}" assert-refspec >/dev/null
          if [[ "{push_status}" -ne 0 ]]; then
            return {push_status}
          fi
          printf '%s\\n' "$1" >> "{push_log}"
        }}
        rc=0
        integrate_upstream "{upstream}" "{upstream}" "{conflict_file}" || rc=$?
        printf '%s\\n' "$rc"
        """
    )
    completed = run(["bash", "-c", script], repo, check=False)
    worktree = ""
    for path in repo.rglob("*"):
        if path.is_file() and ".git" not in path.parts and path.name != "conflicts.txt":
            worktree += path.read_text(encoding="utf-8", errors="ignore")
    pushes = push_log.read_text(encoding="utf-8").split() if push_log.exists() else []
    lines = completed.stdout.strip().splitlines()
    rc = int(lines[-1]) if lines else completed.returncode
    return {
        "rc": rc,
        "output": completed.stdout,
        "pushes": pushes,
        "worktree": worktree,
        "conflict_file": conflict_file,
    }


def service_doc(image, sha, percent, tagged):
    revision = f"needtoken-pool-{sha}"
    traffic = [
        {
            "revisionName": "needtoken-pool-" + ("0" * 40),
            "percent": 0 if percent == 100 else 100,
            "url": SERVICE_URL,
        },
        {"revisionName": revision, "percent": percent, "url": SERVICE_URL},
    ]
    if tagged:
        traffic[1]["tag"] = "candidate"
        traffic[1]["url"] = CANDIDATE_URL
    return {
        "status": {"url": SERVICE_URL, "traffic": traffic},
        "spec": {
            "template": {
                "spec": {
                    "serviceAccountName": "runtime@suichong.iam.gserviceaccount.com",
                    "containers": [
                        {
                            "image": image,
                            "env": [
                                {"name": "SERVER_PORT", "value": "8080"},
                                {"name": "JWT_SECRET", "value": SECRET},
                            ],
                            "ports": [{"containerPort": 8080}],
                        }
                    ],
                }
            }
        },
    }


FAKE_GCLOUD = r'''#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

state_path = Path(os.environ["FAKE_STATE"])
log_path = Path(os.environ["FAKE_LOG"])
args = sys.argv[1:]
with log_path.open("a", encoding="utf-8") as handle:
    handle.write(" ".join(args) + "\n")
state = json.loads(state_path.read_text(encoding="utf-8"))
sha = os.environ["FAKE_SHA"]
image = os.environ["FAKE_IMAGE"]
old_image = os.environ["FAKE_OLD_IMAGE"]
secret = os.environ["FAKE_SECRET"]
revision = f"needtoken-pool-{sha}"
old_revision = "needtoken-pool-" + ("0" * 40)

def container(image_ref, secret_value):
    return {
        "image": image_ref,
        "env": [
            {"name": "SERVER_PORT", "value": "8080"},
            {"name": "JWT_SECRET", "value": secret_value},
        ],
        "ports": [{"containerPort": 8080}],
    }

def emit_service():
    phase = state["phase"]
    current_image = image if phase != "before" else old_image
    secret_value = "rotated-secret" if state.get("break_env") and phase != "before" else secret
    if phase == "promoted":
        traffic = [{"revisionName": revision, "percent": 100, "url": os.environ.get("SERVICE_URL", "https://needtoken-pool-iipumltoca-as.a.run.app")}]
    elif phase == "staged":
        traffic = [
            {"revisionName": old_revision, "percent": 100, "url": "https://needtoken-pool-iipumltoca-as.a.run.app"},
            {"revisionName": revision, "percent": 0, "url": "https://needtoken-pool-iipumltoca-as.a.run.app"},
        ]
    else:
        traffic = [{"revisionName": old_revision, "percent": 100, "url": "https://needtoken-pool-iipumltoca-as.a.run.app"}]
    if state.get("tag"):
        for item in traffic:
            if item["revisionName"] == revision:
                item["tag"] = "candidate"
                item["url"] = "https://candidate---needtoken-pool-iipumltoca-as.a.run.app"
    payload = {
        "status": {"url": "https://needtoken-pool-iipumltoca-as.a.run.app", "traffic": traffic},
        "spec": {"template": {"spec": {
            "serviceAccountName": "runtime@suichong.iam.gserviceaccount.com",
            "containers": [container(current_image, secret_value)],
        }}},
    }
    json.dump(payload, sys.stdout)

if "update-traffic" in args:
    joined = " ".join(args)
    if "--to-revisions" in joined:
        state["phase"] = "promoted"
    elif "--update-tags" in joined:
        state["tag"] = True
    elif "--remove-tags" in joined:
        state["tag"] = False
    state_path.write_text(json.dumps(state), encoding="utf-8")
    sys.exit(0)
if "revisions" in args and "describe" in args:
    if state["phase"] == "before":
        print("ERROR: (gcloud.run.revisions.describe) NOT_FOUND: Revision not found", file=sys.stderr)
        sys.exit(1)
    json.dump({"spec": {"containers": [container(image, secret)]}}, sys.stdout)
    sys.exit(0)
if "services" in args and "update" in args:
    if "--no-traffic" not in args or "--image" not in args:
        print("fake gcloud rejected an unsafe update", file=sys.stderr)
        sys.exit(1)
    state["phase"] = "staged"
    state["tag"] = "--tag" in args
    state_path.write_text(json.dumps(state), encoding="utf-8")
    sys.exit(0)
if "services" in args and "describe" in args:
    emit_service()
    sys.exit(0)
print("unexpected gcloud invocation", file=sys.stderr)
sys.exit(1)
'''

FAKE_CURL = r'''#!/usr/bin/env python3
import sys
args = sys.argv[1:]
outfile = None
url = None
index = 0
while index < len(args):
    item = args[index]
    if item == "-o":
        outfile = args[index + 1]
        index += 2
        continue
    if item in {"-w", "-H"}:
        index += 2
        continue
    if item.startswith("-"):
        index += 1
        continue
    url = item
    index += 1
body = '{"status":"ok"}' if url and url.endswith("/health") else "<!doctype html><title>needtoken</title>"
if outfile:
    open(outfile, "w", encoding="utf-8").write(body)
sys.stdout.write("200")
'''


if __name__ == "__main__":
    unittest.main()
