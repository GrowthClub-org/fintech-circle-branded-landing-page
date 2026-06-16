# Graph Report - fintech-circle-branded-landing-page  (2026-06-16)

## Corpus Check
- 2 files · ~52,403 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 19 nodes · 27 edges · 3 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `fd2933da`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]

## God Nodes (most connected - your core abstractions)
1. `doPost()` - 6 edges
2. `setupSpreadsheet()` - 4 edges
3. `getRegistrationHeaders()` - 3 edges
4. `getApplicationHeaders()` - 3 edges
5. `prepareApplicationRow()` - 3 edges
6. `determineApplicationStatus()` - 3 edges
7. `sendApplicationNotification()` - 3 edges
8. `prepareRegistrationRow()` - 2 edges
9. `setupSheet()` - 2 edges

## Surprising Connections (you probably didn't know these)
- `doPost()` --calls--> `getRegistrationHeaders()`  [EXTRACTED]
  google-sheets-script-enhanced.js → google-sheets-script-enhanced.js  _Bridges community 1 → community 0_

## Communities (3 total, 0 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.32
Nodes (3): getRegistrationHeaders(), setupSheet(), setupSpreadsheet()

### Community 1 - "Community 1"
Cohesion: 0.4
Nodes (6): determineApplicationStatus(), doPost(), getApplicationHeaders(), prepareApplicationRow(), prepareRegistrationRow(), sendApplicationNotification()

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `doPost()` connect `Community 1` to `Community 0`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **Why does `setupSpreadsheet()` connect `Community 0` to `Community 1`?**
  _High betweenness centrality (0.009) - this node is a cross-community bridge._
- **Why does `getRegistrationHeaders()` connect `Community 0` to `Community 1`?**
  _High betweenness centrality (0.002) - this node is a cross-community bridge._