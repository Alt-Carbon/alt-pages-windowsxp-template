---
title: What a carbon tonne is made of
date: 2025-08-21
blurb: Rock, rain, soil samples and a lot of spreadsheets.
---
A tonne of removed carbon is a claim backed by measurements. When someone buys one, they are buying a chain of evidence that starts in a field and ends in a spreadsheet. This is a tour of that chain, from the software side.

## The field

Basalt dust goes onto farmland. Rain dissolves it slowly, and the reaction pulls carbon dioxide out of the air and carries it away as dissolved carbon. Nobody can watch that happen, so we measure around it:

1. What went onto the field: how much rock, from which quarry, of what composition.
2. What the soil looked like before: samples from fixed points, taken before spreading.
3. What changed after: the same points, sampled again across seasons.

Each step produces paperwork. Most of the paperwork used to live in notebooks.

## The sample

A soil sample is a bag of earth with a label. The label is where most of our problems started. A smudged date, a field name spelled two ways, a point number written down from memory that evening. The lab result is only as good as the label it comes back attached to.

> A measurement you cannot trace back to a place and a time is not a measurement. It is a number.

So the first tool we built was not clever. It is a form that runs on a phone with no signal, fills in the field and point from GPS, and prints a label. The person in the field types almost nothing.

## The spreadsheet

Results come back from the lab as files. We join them to the sample records and check them before anyone does any arithmetic:

| Check | Why it matters |
| --- | --- |
| Every result has a sample | Orphan results are usually typos in the label |
| Every sample has a result | Missing results are lost bags or lab backlog |
| Values sit in a sane range | A misplaced decimal looks like a miracle field |

The joining step is short enough to show:

```python
results = lab.merge(samples, on="sample_id", how="outer", indicator=True)
orphans = results[results["_merge"] != "both"]
```

Only after the `orphans` list is empty does anything go to the scientists.

## The tonne

What a buyer finally sees is one number with a range around it.[^1] Behind it sit a few hundred bags of soil, a few thousand form submissions, and a long list of small corrections nobody will ever read. That list is the product. The number is a summary of it.

[^1]: The range is not a disclaimer. It is the honest part of the claim, and it gets narrower as the evidence improves.
