#!/usr/bin/env python3
"""Decision helpers for NeedToken pool deploy and upstream sync.

The product binary is unchanged. These helpers only decide whether CI may
deploy, which immutable image ref is acceptable, and how an upstream SHA
becomes one ordinary merge pull request.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlparse

ORIGIN_REPO = "NeedTokenAi/needtoken-pool"
UPSTREAM_REPO = "Wei-Shaw/sub2api"
REQUIRED_CHECK_JOBS = (
    "shell",
    "test",
    "frontend",
    "golangci-lint",
    "release-helpers",
    "ops-infra",
)
GATE_JOB = "required-checks"
HISTORICAL_SMOKE_URL = "https://needtoken-pool-iipumltoca-as.a.run.app"
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
RELEASE_CHANNELS = {"release", "stable", "latest"}
TAG_NAME = re.compile(r"^v[0-9A-Za-z][0-9A-Za-z._+-]*$")
BRANCH_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$")
SERVICE_ACCOUNT = re.compile(
    r"^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z0-9-]+\.iam\.gserviceaccount\.com$"
)
WIF_PROVIDER = re.compile(
    r"^projects/[0-9]+/locations/global/workloadIdentityPools/[a-z0-9-]+/providers/[a-z0-9-]+$"
)


class OpsError(Exception):
    """A gate or validation failure that should stop the workflow."""


def _sha(value: object) -> str:
    text = str(value or "").strip().lower()
    if not FULL_SHA.fullmatch(text):
        raise OpsError("expected a 40-character lowercase hex SHA")
    return text


def assert_required_checks(needs: Mapping[str, Any]) -> None:
    """Fail unless every deploy-gate job succeeded and no extra job was skipped."""
    missing = [name for name in REQUIRED_CHECK_JOBS if name not in needs]
    bad: dict[str, str] = {}
    for name, payload in needs.items():
        result = ""
        if isinstance(payload, Mapping):
            result = str(payload.get("result") or "")
        if result != "success":
            bad[name] = result or "missing"
    if missing or bad:
        raise OpsError(
            "required checks are incomplete: "
            f"missing={missing or '-'} bad={bad or '-'}"
        )


def deploy_gate(event: Mapping[str, Any]) -> dict[str, str]:
    """Decide whether this workflow may build and roll a pinned SHA.

    workflow_run deploys only the current main SHA after a successful push CI
    run in this repository. A manual dispatch may roll an older SHA that is
    still contained in main. Neither path accepts a fork or a pull request.
    """
    repository = str(event.get("repository") or "")
    if repository != ORIGIN_REPO:
        return _skip(f"repository is {repository or 'empty'}")

    event_name = str(event.get("event_name") or "")
    serving = str(event.get("serving_sha") or "").strip().lower()

    if event_name == "workflow_run":
        if str(event.get("workflow_name") or "") != "CI":
            return _skip("trigger workflow is not CI")
        if str(event.get("run_event") or "") != "push":
            return _skip("CI run was not a push")
        if str(event.get("head_branch") or "") != "main":
            return _skip("CI run was not on main")
        if str(event.get("conclusion") or "") != "success":
            return _skip("CI conclusion was not success")
        if str(event.get("head_repository") or "") != ORIGIN_REPO:
            return _skip("CI head repository is not this repository")
        try:
            sha = _sha(event.get("head_sha"))
            main_sha = _sha(event.get("main_sha"))
        except OpsError as exc:
            return _skip(str(exc))
        if sha != main_sha:
            return _skip("stale")
        if serving == sha:
            return _skip("duplicate")
        return {"deploy": "true", "sha": sha, "reason": "ci-success", "event_name": event_name}

    if event_name == "workflow_dispatch":
        if str(event.get("ref") or "") != "refs/heads/main":
            return _skip("workflow_dispatch ref is not refs/heads/main")
        try:
            sha = _sha(event.get("input_sha"))
        except OpsError as exc:
            return _skip(str(exc))
        if str(event.get("on_main") or "").lower() != "true":
            return _skip("git_sha is not contained in main")
        if serving == sha:
            return _skip("duplicate")
        return {"deploy": "true", "sha": sha, "reason": "manual", "event_name": event_name}

    return _skip(f"unsupported event {event_name or 'empty'}")


def _skip(reason: str) -> dict[str, str]:
    return {"deploy": "false", "sha": "", "reason": reason, "event_name": ""}


def parse_channel(channel: str) -> dict[str, str]:
    """Map UPSTREAM_CHANNEL to one upstream ref. The caller pins that ref to a SHA."""
    value = channel.strip()
    if not value or any(char.isspace() for char in value):
        raise OpsError("UPSTREAM_CHANNEL is empty")
    if value in RELEASE_CHANNELS:
        return {"kind": "release", "git_ref": "", "label": value}
    if value.startswith("refs/tags/"):
        tag = value.removeprefix("refs/tags/")
        if not TAG_NAME.fullmatch(tag):
            raise OpsError("tag channel is not a single tag name")
        return {"kind": "tag", "git_ref": f"refs/tags/{tag}", "label": tag}
    if value.startswith("refs/heads/"):
        branch = value.removeprefix("refs/heads/")
        _validate_branch(branch)
        return {"kind": "branch", "git_ref": f"refs/heads/{branch}", "label": branch}
    if TAG_NAME.fullmatch(value):
        return {"kind": "tag", "git_ref": f"refs/tags/{value}", "label": value}
    _validate_branch(value)
    return {"kind": "branch", "git_ref": f"refs/heads/{value}", "label": value}


def _validate_branch(branch: str) -> None:
    if (
        not BRANCH_NAME.fullmatch(branch)
        or ".." in branch
        or branch.endswith("/")
        or branch.endswith(".lock")
        or branch.startswith("-")
        or "*" in branch
    ):
        raise OpsError("UPSTREAM_CHANNEL is not a single branch name")


def revision_name(service: str, sha: str) -> str:
    commit = _sha(sha)
    name = f"{service}-{commit}"
    if not re.fullmatch(r"[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?", name):
        raise OpsError("Cloud Run revision name is not a valid DNS label")
    if len(name) > 63:
        raise OpsError("Cloud Run revision name exceeds 63 characters")
    return name


def image_repository(region: str, project: str, repository: str, service: str) -> str:
    for label, value in (
        ("region", region),
        ("project", project),
        ("repository", repository),
        ("service", service),
    ):
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,62}", value):
            raise OpsError(f"invalid {label}")
    return f"{region}-docker.pkg.dev/{project}/{repository}/{service}"


def validate_image_ref(image: str, repository_prefix: str) -> str:
    """Accept only a NeedToken Artifact Registry digest. Reject floating and upstream refs."""
    text = image.strip()
    lowered = text.lower()
    if "@sha256:" not in text:
        raise OpsError("image ref must be an immutable digest")
    if ":latest" in lowered or lowered.endswith(":latest"):
        raise OpsError("floating latest tags are rejected")
    for forbidden in ("docker.io", "ghcr.io", "wei-shaw", "gcr.io"):
        if forbidden in lowered:
            raise OpsError("upstream or public mirror image refs are rejected")
    prefix = repository_prefix.rstrip("/") + "@"
    if not text.startswith(prefix):
        raise OpsError("image is outside the NeedToken Artifact Registry repository")
    digest = text.split("@", 1)[1]
    if not DIGEST.fullmatch(digest):
        raise OpsError("image digest is malformed")
    return text


def validate_wif(provider: str, service_account: str) -> None:
    if "private_key" in provider or provider.strip().startswith("{"):
        raise OpsError("JSON service-account keys are rejected")
    if "private_key" in service_account or service_account.strip().startswith("{"):
        raise OpsError("JSON service-account keys are rejected")
    if not WIF_PROVIDER.fullmatch(provider.strip()):
        raise OpsError("GCP_WORKLOAD_IDENTITY_PROVIDER is not a Workload Identity provider resource")
    if not SERVICE_ACCOUNT.fullmatch(service_account.strip()):
        raise OpsError("GCP_SERVICE_ACCOUNT is not a service account email")


def runtime_fingerprint(service: Mapping[str, Any]) -> dict[str, Any]:
    """Capture revision settings that an image-only update must leave unchanged."""
    try:
        template = service["spec"]["template"]["spec"]
        containers = template["containers"]
    except (KeyError, TypeError) as exc:
        raise OpsError("Cloud Run service description is missing the container template") from exc
    if not isinstance(containers, list) or len(containers) != 1:
        raise OpsError("refusing to update a service that does not have exactly one container")
    container = containers[0]
    if not isinstance(container, Mapping):
        raise OpsError("Cloud Run container spec is malformed")
    kept = {key: value for key, value in container.items() if key != "image"}
    return {
        "serviceAccountName": template.get("serviceAccountName"),
        "container": kept,
        "volumes": template.get("volumes"),
        "timeoutSeconds": template.get("timeoutSeconds"),
        "containerConcurrency": template.get("containerConcurrency"),
    }


def runtime_diff_paths(before: Mapping[str, Any], after: Mapping[str, Any]) -> list[str]:
    """Return changed paths. Secret values are never included."""
    left = runtime_fingerprint(before)
    right = runtime_fingerprint(after)
    paths: list[str] = []
    _collect_diff(left, right, "", paths)
    return paths


def _collect_diff(left: Any, right: Any, path: str, paths: list[str]) -> None:
    if type(left) is not type(right):
        paths.append(path or "/")
        return
    if isinstance(left, Mapping):
        keys = sorted(set(left) | set(right), key=str)
        for key in keys:
            child = f"{path}/{key}"
            if key not in left or key not in right:
                paths.append(child)
                continue
            _collect_diff(left[key], right[key], child, paths)
        return
    if isinstance(left, list):
        if len(left) != len(right):
            paths.append(path or "/")
            return
        for index, (item_left, item_right) in enumerate(zip(left, right)):
            _collect_diff(item_left, item_right, f"{path}/{index}", paths)
        return
    if left != right:
        paths.append(path or "/")


def _traffic_items(service: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    traffic = service.get("status", {}).get("traffic", [])
    if not isinstance(traffic, list):
        raise OpsError("Cloud Run traffic status is malformed")
    return [item for item in traffic if isinstance(item, Mapping)]


def revision_percent(service: Mapping[str, Any], revision: str) -> int:
    total = 0
    for item in _traffic_items(service):
        if item.get("revisionName") == revision:
            total += int(item.get("percent") or 0)
    return total


def primary_revision(service: Mapping[str, Any]) -> str:
    best_name = ""
    best_percent = -1
    for item in _traffic_items(service):
        percent = int(item.get("percent") or 0)
        name = str(item.get("revisionName") or "")
        if percent > best_percent and name:
            best_name = name
            best_percent = percent
    return best_name


def tagged_url(service: Mapping[str, Any], tag: str) -> str:
    for item in _traffic_items(service):
        if item.get("tag") == tag and item.get("url"):
            return assert_run_url(str(item["url"]))
    raise OpsError(f"Cloud Run tag {tag} has no URL")


def service_url(service: Mapping[str, Any]) -> str:
    url = str(service.get("status", {}).get("url") or "")
    return assert_run_url(url)


def assert_run_url(url: str) -> str:
    parsed = urlparse(url.strip())
    host = parsed.hostname or ""
    if parsed.scheme != "https" or parsed.username or parsed.password:
        raise OpsError("smoke URL must be https without credentials")
    if not (host.endswith(".a.run.app") or host.endswith(".run.app")):
        raise OpsError("smoke URL host is outside Cloud Run")
    return url.strip().rstrip("/")


def container_image(service: Mapping[str, Any]) -> str:
    try:
        image = service["spec"]["containers"][0]["image"]
    except (KeyError, IndexError, TypeError):
        try:
            image = service["spec"]["template"]["spec"]["containers"][0]["image"]
        except (KeyError, IndexError, TypeError) as exc:
            raise OpsError("revision description has no image") from exc
    if not isinstance(image, str) or not image:
        raise OpsError("revision description has no image")
    return image


def plan_sync(
    *,
    sha: str,
    contained: bool,
    open_prs: list[Mapping[str, Any]],
    remote_branch_exists: bool,
) -> dict[str, str]:
    """Choose the single sync action. A different open sync PR blocks a second one."""
    commit = _sha(sha)
    branch = f"sync/upstream/{commit}"
    sync_prs = [
        pr
        for pr in open_prs
        if str(pr.get("headRefName") or "").startswith("sync/upstream/")
    ]
    same = next((pr for pr in sync_prs if pr.get("headRefName") == branch), None)
    other = next((pr for pr in sync_prs if pr.get("headRefName") != branch), None)
    if contained:
        action = "skip-contained"
    elif other is not None:
        action = "skip-other-open"
    elif same is not None or remote_branch_exists:
        action = "ensure-pr"
    else:
        action = "merge-and-create"
    selected = same or other or {}
    return {
        "action": action,
        "branch": branch,
        "pr_number": str(selected.get("number") or ""),
        "pr_url": str(selected.get("url") or ""),
        "other_branch": str(other.get("headRefName") or "") if other else "",
    }


def sync_pr_body(*, channel: str, label: str, sha: str, main_sha: str) -> str:
    commit = _sha(sha)
    return "\n".join(
        [
            f"Upstream `{UPSTREAM_REPO}` channel `{channel}` resolved to `{label}` at `{commit}`.",
            f"Base `main` was `{_sha(main_sha)}` when this branch was created.",
            "",
            "This branch is an ordinary merge commit of that pinned SHA, with both parents kept.",
            "Merge this pull request with a merge commit.",
            "Squash and rebase discard the upstream parents, so they are the wrong method for this PR.",
            "",
            "The sync workflow fetches only the resolved upstream ref and pushes only "
            f"`sync/upstream/{commit}`. It does not authenticate to GCP.",
            "",
        ]
    )


def conflict_issue_body(
    *,
    channel: str,
    label: str,
    sha: str,
    main_sha: str,
    files: list[str],
) -> str:
    commit = _sha(sha)
    if not files:
        raise OpsError("conflict report has no files")
    listing = "\n".join(f"- `{path}`" for path in files)
    return "\n".join(
        [
            f"<!-- upstream-sync-conflict:{commit} -->",
            "Codex conflict report for the NeedToken upstream sync.",
            "Conflict markers were not committed. No sync branch was pushed.",
            "",
            f"- Upstream: `{UPSTREAM_REPO}`",
            f"- Channel: `{channel}`",
            f"- Resolved: `{label}`",
            f"- Pinned SHA: `{commit}`",
            f"- main: `{_sha(main_sha)}`",
            "",
            "Conflicted files:",
            listing,
            "",
            "Resolve on a local checkout of `main` by merging that exact SHA.",
            f"Push the ordinary merge commit to `sync/upstream/{commit}` and open one pull request into `main`.",
            "Merge that pull request with a merge commit.",
            "",
        ]
    )


def assert_branch_refspec(ref: str, sha: str) -> str:
    commit = _sha(sha)
    expected = f"refs/heads/sync/upstream/{commit}"
    if ref != expected:
        raise OpsError("refusing to push a ref other than the pinned sync branch")
    if "refs/tags" in ref or ref.endswith("*"):
        raise OpsError("refusing to push tags")
    return expected


def write_github_output(values: Mapping[str, str]) -> None:
    destination = os.environ.get("GITHUB_OUTPUT")
    lines = [f"{key}={value}" for key, value in values.items()]
    payload = "\n".join(lines) + "\n"
    if destination:
        with open(destination, "a", encoding="utf-8") as handle:
            handle.write(payload)
    else:
        sys.stdout.write(payload)


def _load_json(path: str) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _print_json(value: Any) -> None:
    sys.stdout.write(json.dumps(value, indent=2, sort_keys=True) + "\n")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        raise OpsError("missing command")
    command = argv[1]
    if command == "assert-required-checks":
        assert_required_checks(json.loads(os.environ["NEEDS"]))
        print("required checks succeeded")
        return 0
    if command == "deploy-gate":
        write_github_output(deploy_gate(_deploy_event_from_env()))
        return 0
    if command == "parse-channel":
        _print_json(parse_channel(os.environ["UPSTREAM_CHANNEL"]))
        return 0
    if command == "revision-name":
        print(revision_name(os.environ["CLOUD_RUN_SERVICE"], os.environ["GIT_SHA"]))
        return 0
    if command == "image-repository":
        print(
            image_repository(
                os.environ["GCP_REGION"],
                os.environ["GCP_PROJECT_ID"],
                os.environ["ARTIFACT_REGISTRY_REPOSITORY"],
                os.environ["CLOUD_RUN_SERVICE"],
            )
        )
        return 0
    if command == "validate-image":
        print(validate_image_ref(os.environ["IMAGE"], os.environ["IMAGE_REPOSITORY"]))
        return 0
    if command == "validate-wif":
        validate_wif(os.environ["GCP_WORKLOAD_IDENTITY_PROVIDER"], os.environ["GCP_SERVICE_ACCOUNT"])
        print("workload identity configuration accepted")
        return 0
    if command == "compare-runtime":
        paths = runtime_diff_paths(_load_json(argv[2]), _load_json(argv[3]))
        if paths:
            raise OpsError("runtime config changed at " + ", ".join(paths))
        print("runtime config preserved")
        return 0
    if command == "revision-percent":
        print(revision_percent(_load_json(argv[2]), argv[3]))
        return 0
    if command == "primary-revision":
        print(primary_revision(_load_json(argv[2])))
        return 0
    if command == "tagged-url":
        print(tagged_url(_load_json(argv[2]), argv[3]))
        return 0
    if command == "service-url":
        print(service_url(_load_json(argv[2])))
        return 0
    if command == "container-image":
        print(container_image(_load_json(argv[2])))
        return 0
    if command == "plan-sync":
        payload = json.loads(sys.stdin.read())
        _print_json(
            plan_sync(
                sha=payload["sha"],
                contained=bool(payload["contained"]),
                open_prs=payload.get("open_prs") or [],
                remote_branch_exists=bool(payload.get("remote_branch_exists")),
            )
        )
        return 0
    if command == "pr-body":
        sys.stdout.write(
            sync_pr_body(
                channel=os.environ["UPSTREAM_CHANNEL"],
                label=os.environ["UPSTREAM_LABEL"],
                sha=os.environ["GIT_SHA"],
                main_sha=os.environ["MAIN_SHA"],
            )
        )
        return 0
    if command == "conflict-body":
        files = [line.strip() for line in Path(argv[2]).read_text(encoding="utf-8").splitlines() if line.strip()]
        sys.stdout.write(
            conflict_issue_body(
                channel=os.environ["UPSTREAM_CHANNEL"],
                label=os.environ["UPSTREAM_LABEL"],
                sha=os.environ["GIT_SHA"],
                main_sha=os.environ["MAIN_SHA"],
                files=files,
            )
        )
        return 0
    if command == "assert-refspec":
        print(assert_branch_refspec(os.environ["PUSH_REF"], os.environ["GIT_SHA"]))
        return 0
    if command == "assert-url":
        print(assert_run_url(os.environ["SMOKE_URL"]))
        return 0
    raise OpsError(f"unknown command {command}")


def _deploy_event_from_env() -> dict[str, str]:
    keys = (
        "event_name",
        "repository",
        "workflow_name",
        "run_event",
        "conclusion",
        "head_branch",
        "head_sha",
        "head_repository",
        "ref",
        "input_sha",
        "main_sha",
        "on_main",
        "serving_sha",
    )
    return {key: os.environ.get(key.upper(), "") for key in keys}


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except OpsError as exc:
        print(f"needtoken-ops: {exc}", file=sys.stderr)
        raise SystemExit(1)
