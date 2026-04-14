"""kuutar v0 demo: build the nyrkiov3_v0 app, seed synthetic data,
mount kuutar's static/ at /, run under uvicorn.

    python demo_server.py
    # open http://localhost:8000/
"""
import datetime
import math
import os
import random
import sys

from nyrkiov3_v0.app import build_app


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
        ("latency",       "ms",    lambda: rng.uniform(10, 200)),
        ("throughput",    "ops/s", lambda: rng.uniform(1_000, 50_000)),
        ("artifact_size", "MB",    lambda: rng.uniform(5, 150)),
        ("error_rate",    "%",     lambda: rng.uniform(0.1, 5.0)),
        ("requests",      "count", lambda: rng.uniform(100, 5000)),
    ]

    def insert_series(test_name, metric_name, unit, baseline, noise_pct,
                      step_day=None, step_mult=1.0, outlier_day=None, outlier_mult=1.0):
        for d in range(DAYS):
            ts = start + datetime.timedelta(days=d)
            level = baseline * (step_mult if step_day is not None and d >= step_day else 1.0)
            val = level + rng.gauss(0, level * noise_pct)
            if d == outlier_day:
                val = baseline * outlier_mult if outlier_mult > 0 else baseline * 0.01
            runs.insert_one(Document(
                absolute_name="gh/demo/bench",
                branch="main",
                git_commit=f"c{d:04d}",
                timestamp=ts,
                attributes={"test_name": test_name},
                metrics=[{"name": metric_name, "unit": unit, "value": val}],
                passed=True,
            ))

    N_SERIES = 40
    for i in range(N_SERIES):
        metric, unit, baseline_fn = FAMILIES[i % len(FAMILIES)]
        baseline = baseline_fn()
        # Noise scales from very tight (0.5%) to quite scattered (20%) across the 40 series.
        noise_pct = 0.005 + (i / max(1, N_SERIES - 1)) * 0.195

        # ~30% chance of a step-function change point.
        step_day = step_mult = None
        if rng.random() < 0.30:
            step_day = rng.randint(30, DAYS - 15)
            # ±15–40% step
            direction = rng.choice([-1, 1])
            step_mult = 1.0 + direction * rng.uniform(0.15, 0.40)

        # ~20% chance of a singular outlier (drop to near-zero or 2x/3x).
        outlier_day = outlier_mult = None
        if rng.random() < 0.20:
            outlier_day = rng.randint(0, DAYS - 1)
            outlier_mult = rng.choice([0.0, 2.0, 3.0])

        insert_series(
            test_name=f"bench_{i:02d}",
            metric_name=metric, unit=unit, baseline=baseline,
            noise_pct=noise_pct,
            step_day=step_day, step_mult=step_mult if step_day is not None else 1.0,
            outlier_day=outlier_day, outlier_mult=outlier_mult if outlier_day is not None else 1.0,
        )


def main():
    app = build_app()
    _seed_demo(app)
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
