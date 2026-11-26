[eval] <https://github.com/davay42/git-forest/eval/>
[gf] <https://github.com/davay42/git-forest/>
[sh] <http://www.w3.org/ns/shacl#>
[prov] <http://www.w3.org/ns/prov#>

# Eval Agent {=eval:agent .prov:SoftwareAgent label}
> Live SHACL evaluation of every MD-LD document in the forest, gated against
> the contract shapes embedded in the root `index.md` itself. {comment}

The Eval Agent is the forest's admission gate made visible. It discovers every
`index.md` — the kernel's own ontology plus each mounted component's — parses
them to quads, and runs `evaluate()` from `public/mdld-parse.js` against the
contract shapes in [./shapes.md](./shapes.md). The result is two views of one
traversal: **violations** (what failed, with focus node and message) and
**records** (what conforms, rendered as semantic tables via `recordTable()`).

## Entities

### Contract {=eval:Contract .prov:Entity label}
> The SHACL shapes embedded in the root [index.md](../../index.md) —
> `gf:RoleContractShape` and `gf:PlanShape`: every `prov:Role` must declare
> trigger, path, input, output, prerequisite, and exactly one `prov:Plan`;
> every `prov:Plan` must carry exactly one `prov:value`. The seed evaluates itself. {comment}

### Document {=eval:Document .prov:Entity label}
> An MD-LD file under evaluation: kernel `index.md` or a component's
> `index.md`. {comment}

## Roles

### Discover Documents Role {=eval:discover .prov:Role label}
> Finds every agent-describing MD-LD file in the forest. {comment}

[GET /] {gf:hasTrigger}
[./index.js] {gf:hasPath}
[HTTP request] {gf:expectsInput}
[root index.md plus */index.md of non-hidden, non-public dirs] {gf:generatesOutput}
[Request received] {gf:requiresPrerequisite}

### Evaluate Role {=eval:evaluate .prov:Role label}
> Parses each document and gates it against the contract shapes. {comment}

[GET /] {gf:hasTrigger}
[./index.js] {gf:hasPath}
[root index.md quads filtered to sh: terms and shape-typed subjects] {gf:expectsInput}
[{conforms, violations, records} per document] {gf:generatesOutput}
[Root index.md parses and yields shape quads] {gf:requiresPrerequisite}

## The Loop

```
index.md files ──parse()──▶ quads ──evaluate()──▶ violations + records
     ▲                                                    │
     └────────── violations are curation tasks ◀───────────┘
```

A role that cannot say what triggers it, what it reads, or what it promises is
a role that doesn't exist — the shape makes the absence a violation, not a
surprise. Fix the document, reload, watch the count drop.
