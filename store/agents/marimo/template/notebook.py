import marimo

__generated_with = "0.24.2"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    import numpy as np
    import pandas as pd
    import altair as alt
    return alt, mo, np, pd


@app.cell
def _(mo):
    mo.md(
        """
        # A reactive notebook

        Change the slider; every cell that depends on it re-runs. Tell the agent what you want to
        analyse, model or show, and it rewrites this file — the pane follows.
        """
    )
    return


@app.cell
def _(mo):
    n = mo.ui.slider(10, 500, value=120, label="points")
    n
    return (n,)


@app.cell
def _(n, np, pd):
    rng = np.random.default_rng(7)
    df = pd.DataFrame({"x": rng.normal(size=n.value), "y": rng.normal(size=n.value)})
    df.describe()
    return (df,)


@app.cell
def _(alt, df, mo):
    chart = (
        alt.Chart(df)
        .mark_circle(size=60, opacity=0.7)
        .encode(x="x", y="y", tooltip=["x", "y"])
        .properties(height=320)
    )
    mo.ui.altair_chart(chart)
    return


if __name__ == "__main__":
    app.run()
