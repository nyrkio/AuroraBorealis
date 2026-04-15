# Aurora Borealis — PLAN

(Name from Kalevala. "Moon-maiden" / weaver of celestial fabric — fitting for a 3D surface visualization.)

## Purpose
three.js-based graph component for the Nyrkiö dashboard. Plots test results over time on X, value on Y, **and a third axis (Z) for related test runs / metrics / configurations**. Correlated runs form a surface; regressions stand out as ridges/troughs.

## Pre-reads (from master plan)
- https://www.intelligentgraphicandcode.com/development/threejs-interfaces
- https://www.intelligentgraphicandcode.com/development/threejs-interfaces/data-visualisation

(Both fetched; review before component design starts.)

## Core component features
- Time-range selector (grafana/datadog style: zoom, pan, presets, absolute & relative).
- Filter/group by **any attribute**, not just `test_name`. Drives Z-axis composition.
- Surface rendering with optional point-cloud / line-strip fallback for sparse data.
- Click → drill-down (single time series, change-point context, raw artifact link).
- Change points overlaid as markers on the surface.
- Designed for **public read-only** mode (anonymous browsing of `nyrkio.com/public`) and **authenticated** mode.

## Tech choices

### Framework wrapper around three.js
Two options, both compatible with the nyrkiov3 frontend decision:

- **Vanilla wrapper class** — `new Aurora(canvasEl, opts)` with a small imperative API (`.setData()`, `.setTimeRange()`, `.on('select', ...)`). Works from htmx pages, Svelte, or anything else. No framework dependency. Recommended starting point.
- **Svelte component** wrapping the same vanilla class, for nyrkiov3 consumers that want reactivity sugar.

Ship the vanilla class as the core; the Svelte wrapper is a thin convenience layer.

aurora must be a **standalone package usable from any host page** — nyrkiov3 dashboard is one consumer (aurora was formerly "kuutar"), public embed pages are another.

### Performance budget
- 60fps interaction with up to 10k data points across surface.
- LOD / decimation for larger sets.
- Worker thread for change-point overlay computation if needed.

## Data API
Consumes the v3 backend endpoints:
- `GET /api/v3/tests/gh/{namespace}/{repo}?branch=&test_name=&metric=&since=&until=`
- `GET /api/v3/pulls/...`

Should also work standalone with a static JSON file (for docs/demos).

## Out of scope for v1
- 4D (time + animation through deploys). Tempting, defer.
- VR/AR mode.

<<< Note that x axis is already time.
<<< VR/AR is interesting indeed. User could be inside of the vizualisation.
<<< A future area is to evolve other perf data like flamegraphs or live metrics data into 3d. For example, visualize threads as a 3D tree, with node sizes and color reflecting some observed value. Also, visualize the values that flow through a neural network, live.

## Open questions
1. Color scheme for value gradients — needs to be colorblind-safe and meaningful (diverging vs. sequential depending on metric type).
2. Does aurora own the time-range UI, or is that part of the host dashboard? Recommend: aurora owns the canvas + minimal in-canvas controls, host owns the chrome.
3. Accessibility — 3D surfaces are inherently visual; we need a **table fallback** view for screen readers and keyboard nav. Don't ship without it.

<<< 2. I don't know. The time range and other selective controls can work in both directions: parameters to a database query, but if data was already loaded, it can stay in RAM but becomes hidden / outside of zoomed window. So maybe it should be part of kuutar, but could be a separate component. (Not necessarily WebGL or 3d at all)
<<< 3. For Nyrkiö use cases, a typical workflow is thhat users select outlier and change points, review the exact value of them and also review git metadata: commit message and author, 
<<< 1. Overall I feel this is a dark color scheme == night sky with silver stars. But outliers and change points could be red and orange. Height is not in itself a color, only to the extent some light and shadows help understand the form and height of hthe graph in different areas.
