"""kuutar v0 demo: build the nyrkiov3_v0 app, seed synthetic data,
mount kuutar's static/ at /, run under uvicorn.

    python demo_server.py
    # open http://localhost:8000/
"""
import datetime
import hashlib
import math
import os
import random
import sys

from nyrkiov3.app import build_app, DEFAULT_SNAPSHOT_PATH


AUTHORS = [
    "Anna Virtanen", "Ben Lindqvist", "Charlie Park", "Dana Okafor",
    "Erik Saari", "Fiona O'Neill", "Gabe Rivera",
]

NORMAL_VERBS = [
    "tidy", "update docs for", "rename", "adjust", "inline",
    "simplify", "reorder", "dedupe", "guard", "annotate",
    "lint", "format",
]

IMPACT_VERBS = [
    "refactor", "rewrite", "switch", "optimize", "port", "replace",
    "vectorize", "cache", "reindex", "parallelize", "batch", "prune",
]

HOTFIX_VERBS = ["hotfix", "revert", "disable", "roll back", "patch"]

SUBJECTS = [
    "the parser", "metric aggregation", "the bench harness",
    "the startup path", "retry loop", "timeout logic",
    "config loader", "the result cache", "connection pool",
    "serialization", "logging layer", "the ingest path",
    "scheduler", "the event bus", "worker dispatch",
    "the state machine", "request routing", "db adapter",
    "auth middleware", "cursor handling",
]


def _make_commits(rng, n_days, start_date, change_days, outlier_days, repo):
    """One commit per day, shaped to benchzoo v2 `commit` sub-document
    (repo, sha, ref, commit_time) extended with message/author/short_sha.

    Impact verbs on change-point days, hotfix on outlier days, boring
    tidy/rename commits everywhere else."""
    commits = []
    for d in range(n_days):
        ts = start_date + datetime.timedelta(days=d)
        if d in outlier_days:
            verb = rng.choice(HOTFIX_VERBS)
        elif d in change_days:
            verb = rng.choice(IMPACT_VERBS)
        else:
            verb = rng.choice(NORMAL_VERBS)
        message = f"{verb} {rng.choice(SUBJECTS)}"
        author = rng.choice(AUTHORS)
        sha = hashlib.sha1(f"{d}|{message}|{author}".encode()).hexdigest()
        commits.append({
            "repo": repo,
            "sha": sha,
            "ref": "main",
            "commit_time": int(ts.timestamp()),
            "short_sha": sha[:7],
            "author": author,
            "message": message,
        })
    return commits


def _seed_demo(app):
    runs = app.store.collection("test_runs")
    repos = app.store.collection("repos")
    # The app's ingest handler would normally auto-create repos, but we're seeding
    # directly. Stub the repo so list/* queries work.
    from purejson import Document
    from extjson import ObjectId, utcnow
    repo = Document(
        platform="gh", namespace="demo", repo="bench",
        absolute_name="gh/demo/bench",
        installed_at=utcnow(),
    )
    repos.insert_one(repo)

    # 6 months of history: the latest 3 map to positive X (bright), the
    # previous 3 map to negative X and fade into the past.
    DAYS = 180
    now = datetime.datetime(2026, 4, 15, tzinfo=datetime.timezone.utc)
    start = now - datetime.timedelta(days=DAYS - 1)
    rng = random.Random(42)

    # Variety of metric kinds so the shape vocabulary is well-represented.
    FAMILIES = [
        ("latency",       "ms",    "lower_is_better",  lambda: rng.uniform(10, 200)),
        ("throughput",    "ops/s", "higher_is_better", lambda: rng.uniform(1_000, 50_000)),
        ("artifact_size", "MB",    "lower_is_better",  lambda: rng.uniform(5, 150)),
        ("error_rate",    "%",     "lower_is_better",  lambda: rng.uniform(0.1, 5.0)),
        ("requests",      "count", "higher_is_better", lambda: rng.uniform(100, 5000)),
    ]

    # Pre-plan change/outlier days across all series so we can colour the
    # daily commits accordingly.
    N_SERIES = 40
    plans = []
    change_days = set()
    outlier_days = set()
    for i in range(N_SERIES):
        metric, unit, direction, baseline_fn = FAMILIES[i % len(FAMILIES)]
        baseline = baseline_fn()
        noise_pct = 0.005 + (i / max(1, N_SERIES - 1)) * 0.195
        step_day = step_mult = None
        if rng.random() < 0.30:
            step_day = rng.randint(30, DAYS - 15)
            sign = rng.choice([-1, 1])
            step_mult = 1.0 + sign * rng.uniform(0.15, 0.40)
            change_days.add(step_day)
        outlier_day = outlier_mult = None
        if rng.random() < 0.20:
            outlier_day = rng.randint(0, DAYS - 1)
            outlier_mult = rng.choice([0.0, 2.0, 3.0])
            outlier_days.add(outlier_day)
        plans.append({
            "test_name": f"bench_{i:02d}",
            "metric": metric, "unit": unit, "direction": direction, "baseline": baseline,
            "noise_pct": noise_pct,
            "step_day": step_day, "step_mult": step_mult if step_day is not None else 1.0,
            "outlier_day": outlier_day, "outlier_mult": outlier_mult if outlier_day is not None else 1.0,
        })

    commits = _make_commits(rng, DAYS, start, change_days, outlier_days, repo="demo/bench")

    def insert_series(plan):
        baseline = plan["baseline"]
        step_day, step_mult = plan["step_day"], plan["step_mult"]
        outlier_day, outlier_mult = plan["outlier_day"], plan["outlier_mult"]
        for d in range(DAYS):
            ts = start + datetime.timedelta(days=d)
            level = baseline * (step_mult if step_day is not None and d >= step_day else 1.0)
            val = level + rng.gauss(0, level * plan["noise_pct"])
            if d == outlier_day:
                val = baseline * outlier_mult if outlier_mult > 0 else baseline * 0.01
            commit = commits[d]
            # v2-style `commit` sub-document at top level. The legacy v1
            # fields (`git_commit`, `branch`) are still present because
            # the rest of the stack hasn't migrated yet.
            runs.insert_one(Document(
                absolute_name="gh/demo/bench",
                branch="main",
                git_commit=commit["sha"],
                timestamp=ts,
                attributes={"test_name": plan["test_name"]},
                metrics=[{"name": plan["metric"], "unit": plan["unit"],
                          "direction": plan["direction"], "value": val}],
                commit=commit,
                passed=True,
            ))

    for plan in plans:
        insert_series(plan)


def main():
    # Persist to /home/claude/data so real data we later ingest (Turso,
    # UnoDB) survives restarts. On first run the store is empty and we
    # seed the synthetic demo; subsequent runs reload the snapshot.
    # Delete the snapshot file to start over.
    app = build_app(snapshot_path=DEFAULT_SNAPSHOT_PATH)
    runs = app.store.collection("test_runs")
    # Seed demo data if its namespace specifically is missing, so real
    # ingested data (UnoDB etc.) in the same store doesn't block it.
    demo_count = runs.count({"absolute_name": "gh/demo/bench"})
    if demo_count == 0:
        _seed_demo(app)
        print(f"seeded demo data; snapshotting to {DEFAULT_SNAPSHOT_PATH}")
    n = runs.count()
    print(f"store has {n} runs (from {DEFAULT_SNAPSHOT_PATH})")
    here = os.path.dirname(os.path.abspath(__file__))
    app.static("/", os.path.join(here, "static"))

    try:
        import uvicorn
    except ImportError:
        print("uvicorn not installed. `pip install uvicorn` and rerun.", file=sys.stderr)
        sys.exit(1)
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")


if __name__ == "__main__":
    main()
