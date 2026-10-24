# Free WIPO access

The Hub exposes two credential-free WIPO access helpers through `research_external_access`, the `external` CLI action, and the editable `patent-research-external-access-core` n8n subworkflow. These helpers return official links and use instructions only. They do not query WIPO, acquire records, or create research evidence.

## PATENTSCOPE

Call with `{ "source": "wipo-patentscope", "query": "G06N neural network" }`. The response preserves the proposed query as `searchFor` and opens the official manual search interface. WIPO says PATENTSCOPE covers published PCT applications and participating national/regional collections, prohibits robots and bulk database downloads, and permits a logged-in user with a free WIPO account to download result lists up to 10,000 records. Coverage differs by collection. PATENTSCOPE's document count also has its own grouping rule, so a displayed count is not automatically a count of families, inventions, enforceable rights, or current owners.

Run searches and exports manually. If an exported result list or an individual original is needed in reusable research, acquire that file separately through Get Files or normalize a local export through Context Forge, preserving the query, filters, search date, export limit, and WIPO source URL. A generated link is never a source record.

Official references: [PATENTSCOPE FAQ](https://www.wipo.int/en/web/patentscope/faqs_patentscope), [user guide](https://www.wipo.int/documents/d/patentscope/docs-en-patentscope_user_guide.pdf), and [search](https://patentscope.wipo.int/search/en/search.jsf).

## IP Statistics Data Center

Call with `{ "source": "wipo-ip-statistics", "query": "patent applications by origin" }`. The optional `query` is only a human-readable research cue; it is not translated into Data Center parameters. The returned link opens WIPO's free interactive service, where a user can select indicators and view or download aggregate latest or historical data.

Every downloaded table should retain the indicator, IP type, reporting type, geography/origin or office filters, year range, download date, and accompanying methodology notes. WIPO documents material distinctions involving first-named-applicant origin, missing values, estimated totals, fractional technology counts, PCT recency, and revision of Patstat-derived indicators. Consequently, an export is not self-defining and must not be described as a complete patent population without validating those choices.

Official references: [Data Center](https://www3.wipo.int/ipstats/), [about and methodology](https://www.wipo.int/en/web/ip-statistics/about), and [IP statistics catalog](https://www.wipo.int/en/web/ip-statistics).

## Automation boundary

No PATENTSCOPE robot, scraper, guessed endpoint, paid PCT web-service subscription, or undocumented IP Statistics API is included. The portable n8n workflow is inactive and credential-free; publishing or deploying it is a separate controlled operation. It is useful as an editable callable adapter because all callers receive the same truthful access contract, not because it automates WIPO.
