# How digital lives and personal agents learn to use social tools

Research date: 2026-10-28. This document records an investigation of primary documentation and source code. It is not an accepted implementation plan; no deployment, QQ login, or actual publishing was performed.
Source-code findings are pinned to the inspected commits. Product documentation and examples do not establish the actual behavior of every current version. The sections below distinguish built-in framework capabilities, third-party plugins, and design recommendations.

## Findings

These projects do not share a single "digital life skills architecture." The common approach supported by the evidence is:

1. Give the model understandable capability descriptions, including usage scenarios, procedures, and examples.
2. Give the model usable state and resources, such as candidate memes, image contents, recent posts, and chat context.
3. Implement resource management, validation, execution, and result feedback in code.
4. Provide opportunities to think or execute through message events, scheduled tasks, and similar mechanisms.

Skills are suitable for reusable operating knowledge. A skill file does not itself provide image understanding, resource libraries, tool permissions, or scheduled wake-ups.
This separation is explicit in AstrBot's distinction between Tools, MCP, Skills, and plugins, and its requirement for the ability to read skills.
[AstrBot official Skills documentation](https://docs.astrbot.app/use/skills.html)

| Project | Verified organization | Most relevant reference for Luo Qiuyue |
| --- | --- | --- |
| MaiBot / MaiMai | Built-in meme resource management, Planner tools, visual candidates, and a selection workflow | The model needs meme resources it can actually understand and select |
| AstrBot | Framework support for SKILL.md; third-party plugins separately provide tools, message hooks, and scheduling | Skill instructions, platform capabilities, and automatic triggers are implemented separately |
| ElizaOS | Actions + Providers + Services; social plugins provide posting loops | Operating examples, state injection, separate posting opportunities, and content context |

## MaiBot: a complete meme resource and perception pipeline

Verified source: [MaiM-with-u/MaiBot, 6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3](https://github.com/MaiM-with-u/MaiBot/tree/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3).
This is the `maisaka` tool implementation on the inspected main branch; it should not be conflated with the Action activation mechanism of historical versions.

### Collection and understanding: code handles caching, descriptions, and resource maintenance

On receiving a meme component, message handling calls `emoji_manager.get_emoji_description` and turns recognition results into meme label text the model can read.
When no description exists, it can be built asynchronously. Without a configured VLM, the file is retained, but that does not establish that the image has been understood.
[Message reception handling](https://github.com/MaiM-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/chat/message_receive/message.py#L329)
[Meme management and description generation](https://github.com/MaiM-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/emoji_system/emoji_manager.py#L301)

The resource manager looks up cached images by hash, maintains local files and database records, and distinguishes states such as cached, registered, and disabled.
When conditions such as `steal_emoji` permit, the maintenance loop scans candidate files, generates emotion labels and checks content before registration, and may replace resources when capacity is reached.
Seeing an image, caching it, and making it a sendable meme are therefore separate stages, not a single prompt call.
[Saving, registration, and maintenance implementation](https://github.com/MaiM-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/emoji_system/emoji_manager.py)

### Sending: actually showing candidates to the model

With `use_new_send_logic` enabled, `show_emoji_list` randomly samples a configured number of library images and combines them into a numbered collage.
Through `post_history_messages`, this tool adds a `ContextImagePart` to model context. The collage is for model selection and is not sent directly to the chat recipient.
The Planner then specifies a number through `reply.attach_emoji`; `0` or omission means no meme is attached.
[Candidate collage and visual context](https://github.com/MaiM-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/maisaka/builtin_tool/show_emoji_list.py)
[reply parameters](https://github.com/MaiM-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/maisaka/builtin_tool/reply.py#L210)

The old sending mode exposes `send_emoji`. A temporary visual sub-agent selects a number from a candidate collage and returns its reasoning, then the corresponding image is sent.
Registration explicitly switches between `show_emoji_list` and `send_emoji` according to configuration; do not assume both modes are enabled simultaneously.
[Selection and sending in the old mode](https://github.com/MaiM-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/maisaka/builtin_tool/send_emoji.py)
[Tool enablement conditions](https://github.com/MaiM-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/maisaka/builtin_tool/__init__.py#L148)

An inference for this project: a meme skill requires candidates the model can understand. An image URL or ID alone does not mean the model can see its contents.
MaiBot demonstrates one implementation path through visual candidates. Random sampling can still miss suitable resources, and the source code does not establish optimal retrieval quality.
The temporary sub-agent is an observation about an external implementation. Introducing one into Luo Qiuyue would require a separate review against the architectural decision on single Attention.

## AstrBot: Skills and functional plugins coexist

### Framework support for Skills requires discovery and reading

AstrBot's official documentation defines a Skill as a task operating manual: expose its name, description, and path first, then read its body and resources as needed.
The documentation says this format is supported from v4.13.0 and specifically notes that a skill list without file-reading capability cannot guarantee that the model reads the complete instructions.
Plugins can provide their own `skills/` and can also independently register tools, commands, and event handlers.
[Official Skills documentation](https://docs.astrbot.app/use/skills.html)

### Meme stealer: tool descriptions already explain when to use it

The following is a third-party plugin, not a default built-in AstrBot capability.
Verified commit: [nagatoquin33/astrbot_plugin_stealer, 758f94a5b0848c8723a56d20af3da4b8ef3c4e61](https://github.com/nagatoquin33/astrbot_plugin_stealer/tree/758f94a5b0848c8723a56d20af3da4b8ef3c4e61).

The `search_meme` tool description directly tells the model it may proactively search to express emotion, respond to jokes, or reply naturally in conversation, using tone, dialogue, or situation as search criteria.
After receiving candidates, it should check the image text, usage context, and stance of the reply before calling `send_meme`. If none fits, it can search again or reply in text.
`send_meme` accepts only candidate numbers from the current search, making the search-selection-send dependency explicit.
[Tool descriptions and registration](https://github.com/nagatoquin33/astrbot_plugin_stealer/blob/758f94a5b0848c8723a56d20af3da4b8ef3c4e61/main.py#L688)
[Candidate construction and sending](https://github.com/nagatoquin33/astrbot_plugin_stealer/blob/758f94a5b0848c8723a56d20af3da4b8ef3c4e61/core/tools/meme_search_tool.py)

`steal_meme` specifies two usage scenarios: someone asks to save an image, or the model proactively saves an image from the current message that would make a suitable meme.
The input must be an image reference already present in the current message. Actual collection remains subject to the collection switch and session list restrictions.
Its VLM pipeline generates categories, tags, descriptions, and usage scenarios. An `on_message` hook can also process images automatically.
[Collection tool and message hooks](https://github.com/nagatoquin33/astrbot_plugin_stealer/blob/758f94a5b0848c8723a56d20af3da4b8ef3c4e61/main.py#L719)
[Collection workflow](https://github.com/nagatoquin33/astrbot_plugin_stealer/blob/758f94a5b0848c8723a56d20af3da4b8ef3c4e61/core/tools/meme_steal_tool.py)
[Image processing pipeline](https://github.com/nagatoquin33/astrbot_plugin_stealer/blob/758f94a5b0848c8723a56d20af3da4b8ef3c4e61/core/processing/image_processor_service.py)

An inference for this project: for simple capabilities, first explain when to use them, where inputs come from, and the next operation; a separate skill is not needed for every API.
When collection, annotation, retrieval, selection, and use form a coherent method, a meme collection and expression skill becomes more natural.
An automatic message hook is a collection policy, not an Action selected by the Agent according to its own preferences.

### Qzone: tool calls and scheduled posting are separate entry points

The following is also a third-party plugin.
Verified commit: [Zhalslar/astrbot_plugin_qzone, 0f5720f78d7bba45d94778580397e08fcfd02570](https://github.com/Zhalslar/astrbot_plugin_qzone/tree/0f5720f78d7bba45d94778580397e08fcfd02570).

`llm_publish_feed` is registered as an LLM tool, accepts post text, and can attach images from the current conversation.
Another tool, `llm_view_feed`, supports viewing posts and optionally liking or commenting; the underlying service calls Qzone interfaces.
[LLM tool implementation](https://github.com/Zhalslar/astrbot_plugin_qzone/blob/0f5720f78d7bba45d94778580397e08fcfd02570/main.py#L735)

Autonomous posting has a separate `AutoPublish` path: a Cron base time plus a configurable random offset triggers `generate_post()` followed by `publish_post()`.
The generation function retrieves history from a specified group or a randomly selected available group, combining a writing topic with `post_prompt`. When event context exists, it also tries to include the session persona.
Here the scheduler determines when posting is possible, while context and the generation prompt determine what to write. This does not establish that installing a skill naturally creates motivation.
[Scheduling implementation](https://github.com/Zhalslar/astrbot_plugin_qzone/blob/0f5720f78d7bba45d94778580397e08fcfd02570/core/scheduler.py)
[Content generation and persona context](https://github.com/Zhalslar/astrbot_plugin_qzone/blob/0f5720f78d7bba45d94778580397e08fcfd02570/core/llm_action.py#L183)

Limitations: automatically selecting group-chat material for Qzone is this plugin's product choice; it cannot directly become Luo Qiuyue's rule for sharing experiences across Social Contexts.
A publishing entry point in source code also does not establish the long-term availability of authentication, cookies, or specific interfaces in the current QQ environment. This research did not test them live.

## ElizaOS: Action examples, state, and posting services have separate roles

This section relies on current official documentation and its examples. ElizaOS was not run, and not all examples were checked line by line against the current main branch.
In particular, official documentation examples do not replace deployment validation for a specific plugin version.

### Usage instructions can live in an Action

The official Components documentation defines an Action's `description`, `similes`, `examples`, `validate`, and `handler`.
Descriptions and examples help the model decide how to use it; `validate` checks current conditions; a Provider adds state before decisions; a Service maintains connections or long-running tasks.
This organization does not itself require wrapping social behavior in SKILL.md.
[Official Components documentation](https://docs.elizaos.ai/plugins/components)

The multi-step action documentation shows outputs from earlier steps entering the state of later steps, with results carrying `success` and structured `data`, and reminds later steps to check prerequisites.
It also notes that plans may continue by default after a step fails. Do not infer that the framework automatically prevents every problematic subsequent publication.
[Multi-Step Action Planning](https://docs.elizaos.ai/guides/action-planning)

### Social posting has separate opportunities and content sources

The official Twitter/X plugin guide describes a separate Post Client, with an automatic posting switch, minimum and maximum intervals, posting on startup, and timing variation settings.
Its content-generation example combines recent posts, current topics, the character, and `postExamples`; the interaction workflow separately decides whether to respond.
This is an approach in which a service provides execution opportunities while character and context guide content. It does not establish an independent, persistent desire to post.
[Twitter/X Developer Guide](https://docs.elizaos.ai/plugin-registry/platform/twitter/developer-guide)

An inference for this project: how to publish to Qzone can be a skill; what happened recently, what she wants to express, and whether she has already posted should come from actual state.
An Environment Event or Self-directed Wake-up can provide a posting opportunity, but Silence should remain an option when the time arrives.
This is a design recommendation for this project, not a claim that the plugins above implement the same digital life semantics.

## Evidence boundaries

- The linked source commits were read for MaiBot's resource management, candidate collages, and two sending modes, and for the workflows of the two third-party AstrBot plugins above.
- AstrBot Skills, ElizaOS components, and Twitter posting mechanisms are described from the linked official documentation; ElizaOS code snippets are documentation examples.
- This research did not assess persona authenticity, long-term stability, or real-world success rates, and makes no benchmark claims.
- Recommendations must be assessed against this project's existing ADRs. External projects using multiple sub-agents, automatic collection, or scheduled publishing do not justify directly adopting their behavioral policies.

## OpenClaw, Pi, and standard Agent Skills: loading operating knowledge separately

The following findings come from primary documentation and source checks; they do not imply that all these projects support Qzone or meme collection.

- **OpenClaw** explicitly defines skills as Markdown instructions teaching an Agent when and how to use tools. Available skills pass environment, configuration, and dependency checks; the system prompt provides a short catalog, and the model reads bodies on demand. The current documentation also provides `skills_search` to search installed, available skills and `skills_read` to read full bodies. Skill visibility does not grant tool permissions. The value for Luo Qiuyue is contextual operating knowledge while preserving native tool execution boundaries. [Skills](https://docs.openclaw.ai/tools/skills), [System prompt / Skills](https://docs.openclaw.ai/concepts/system-prompt#skills), [Source documentation](https://github.com/openclaw/openclaw/blob/main/docs/tools/skills.md), [Skill search and reading](https://docs.openclaw.ai/tools/skills#search-installed-skills). Proactive scheduled work is separately handled by persistent scheduling; skill loading and wake-up execution must not be conflated. [Automation](https://docs.openclaw.ai/automation).
- **Pi v1.4.0 coding-agent** uses a `name + description + location` catalog and reads `SKILL.md` when a task matches; the description should state the purpose and applicable scenarios. Source code provides `loadSkillsFromDir`, `loadSkills`, and `formatSkillsForPrompt`. These capabilities belong to the **coding-agent package**. Using the **agent-core package** does not imply that an application already has skill discovery, reading, or context management. [Versioned documentation](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/skills.md), [Versioned skill implementation](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/skills.ts), [agent-core documentation](https://github.com/earendil-works/pi/blob/v1.4.0/packages/agent/README.md).
- **The Agent Skills integration guide** describes the complete sequence: discover → expose a catalog → load bodies → manage long-term context. An Agent without file-reading capability can provide a dedicated activation tool rather than opening a general shell just to read skills. The guide also advises preventing skill bodies from being lost during context compaction and deduplicating repeated loads. This is integration guidance, not runtime behavior automatically conferred by the standard format. [Integration guide](https://agentskills.io/integrate-skills), [Format specification](https://agentskills.io/specification).

**Recommendation for this project:** use a `SKILL.md`-compatible file organization, but provide Luo Qiuyue with a dedicated `load_skill(name)` that returns the body as a tool result. If supporting instructions exist, provide restricted resource reading as well. Do not leave bodies only in the repository with neither a visible catalog nor a way for the model to read them. Skill loading should neither change API permissions nor automatically execute scripts.

## Luo Qiuyue's current implementation: tools exist, skill integration is missing

The following is only a static workspace review dated 2026-10-28. It did not read production chats or call traces, so it cannot identify the sole cause of any particular inability to use a tool. `src/tools.ts` and `test/snowluma-tools.test.ts` already had uncommitted changes at review time; this investigation preserved them.

| Observation | Code evidence | Implication |
| --- | --- | --- |
| The pinned catalog contains 209 native SnowLuma interfaces; default permissions are `allow: '*'`, and configuration determines actual availability | [Catalog](../../src/generated/snowluma-catalog.json), [Configuration](../../src/config.ts), [Tools](../../src/tools.ts) | Broad execution capability exists; interface count alone does not establish correct selection |
| All enabled tools and their complete parameters are provided directly to the model; common interfaces have longer descriptions | [Tools](../../src/tools.ts), [Brain](../../src/brain.ts), [ADR-0010](../adr/0010-expose-native-snowluma-actions.md) | Tool detail lookup and skill loading serve different purposes |
| `search_snowluma_tools` searches the catalog, and `load_snowluma_tools` returns parameters, results, examples, and other details; neither changes the available tool set | [Tools](../../src/tools.ts) | The existing load operation is neither a skill loader nor dynamic tool unlocking |
| Meme and Qzone interfaces already have some usage guidance, including annotation after collection, actual IDs, visibility, and handling unknown outcomes | [Tools](../../src/tools.ts) | The problem cannot simply be attributed to a complete lack of call instructions; cross-step workflows and selection criteria should be completed |
| The application depends on and directly creates an Agent from `@earendil-works/pi-agent-core`; there is currently no skills catalog injection or body-loading tool | [Dependencies](../../package.json), [Brain](../../src/brain.ts), [Tools](../../src/tools.ts) | Adding `SKILL.md` files alone will not take effect |
| `schedule_activity`, an autonomous life switch, due wake-ups, current activities, and commitments already exist | [Tools](../../src/tools.ts), [Runtime](../../src/runtime.ts) | Autonomous activities can use these mechanisms without creating a separate scheduled persona for every social skill |

### A perception gap that a skill cannot fill

Current message observations download images from `event.payload.message` as model image inputs; `view_event_image` also reads only that location. Native tool results are serialized as text and stored in `payload.result`; URLs within them do not automatically become image inputs. [Brain](../../src/brain.ts), [Tools](../../src/tools.ts).

Consequently, when `fetch_custom_face_detail` returns a `url` with an empty `desc`, the current general tool pipeline lacks an entry point for directly viewing that saved image. The same issue applies to post-body images returned by Qzone interfaces. An image previously seen in a message or accompanied by a trustworthy description can still be selected on that basis; this does not mean every meme send fails. [Native interface result structures](../../src/generated/snowluma-catalog.json).

**Recommendation:** add image viewing based on real source results, for example using `sourceId + image index/resource identifier` to select images from meme library or Qzone results and return actual image content. Retain the existing address and size restrictions on image reading. A skill should guide when to view and how to describe; the runtime supplies working perception capabilities.

## Suitable skills

The unit here is a complete activity. The following are design recommendations; no skills have been created or enabled.

| Proposed skill | When to consider using it | Workflow to cover | Completion evidence |
| --- | --- | --- | --- |
| `emoji-collection` | Seeing a liked meme worth using later; a Social Request to save one; organizing saved images without descriptions | Read the source → understand the image → check for duplicates within available information → save → use the returned ID to describe content and suitable contexts | Actual collection receipt; annotation result; original event or tool source |
| `emoji-expression` | The current context suits an image response and Luo Qiuyue wants to participate | Read saved images → select by description, viewing images when descriptions are insufficient → confirm the group/private target → send → inspect the receipt | Actual message_id, or an explicit record of failure/unknown outcome |
| `qzone-publish` | An experience, thought, or result of an interest is worth sharing; or she decides to respond to a Social Request to post | Review relevant experiences and recent posts → compose content/select images → assess the original sharing scope and intended visibility → publish → record the result | Actual tid/time; a draft must not be treated as published |
| `qzone-social` | Wanting to catch up with friends; reaching a self-scheduled browsing time; having a relevant post reference | Browse → read details/view images as needed → decide whether to like or comment → correctly reference post and comment IDs → inspect the receipt | Real sources, targets, and action outcomes; choosing not to interact is also valid |

The first iteration could implement only `emoji-collection` and `qzone-publish` to validate integration, then decide whether to separate sending and browsing based on actual skill length.

Each skill should include usage scenarios, inapplicable scenarios, required inputs, operation order, branches for insufficient information, success evidence, handling of failure/unknown outcomes, and one or two complete QQ-oriented examples. Avoid copying parameter tables into the body; current native tools and the detailed catalog remain authoritative for parameters.

For example, the collection workflow should state that `modify_custom_face` is used for annotation only after `add_custom_face` is confirmed successful and a real `emoji_id` is obtained. Descriptions must come only from viewed images. If the result is unknown, inspect `inspect_actions` and verify before proceeding, rather than blindly collecting again. [Current tool guidance and execution records](../../src/tools.ts), [ADR-0008](../adr/0008-preserve-unknown-action-outcomes.md).

### When she wants to act needs separate consideration

A skill can teach how to complete an activity and suggest situations in which to consider it. It does not itself create events, interests, pending activities, or wake-ups.

Autonomous behavior can reuse the existing sequence: Environment Event / Self-directed Wake-up → the same Agent decides whether to act using Initial Persona, Long-term Understanding, and Current Activity → read the relevant skill → call native tools → record Actual Experience and Continuing State. Every new image need not be collected, and fixed daily posting does not establish motivation for life activities. [Glossary](../../GLOSSARY.md), [Runtime](../../src/runtime.ts), [Brain instructions](../../src/brain.ts).

When there is no actual information, silence, rest, or canceling a plan remain valid. Publishing Fictional Daily Life must follow existing configuration and the actual/fictional distinction; character settings cannot establish that real activities were completed. [Brain](../../src/brain.ts), [Configuration](../../src/config.ts).

## Architectural implications and recommended order

1. **Locate the failure layer first.** Use existing observations and action records to distinguish an activity never considered, a tool not found after considering it, workflow/parameter errors, server-side lack of support or call failure, and unknown outcomes. Static review cannot replace this, and call counts alone are insufficient.
2. **Integrate a minimal skill mechanism.** Maintain a runtime skills catalog with short descriptions and a body-loading tool; validate it with two activities first. Store operating knowledge separately from Initial Persona; Core Persona remains under Operator control.
3. **Make resources readable.** In particular, address images in tool results, real IDs, pagination, and saved images with empty descriptions. Without these inputs, longer guides cannot make task completion reliable.
4. **Preserve continuing activities.** Reuse existing activities and self-directed wake-ups. Record the name/version of a skill in progress so its complete operating instructions can be restored after compaction. Protecting or reloading bodies needs a context budget; do not permanently pin every skill ever loaded.
5. **Validate with scenario comparisons.** Compare complete task performance before and after adding skills, recording selection, loading, execution, and receipts rather than merely asserting that Markdown was read.

Suggested validation scenarios: a request to save an image; autonomously finding a liked meme; duplicate collection; selecting saved images with empty descriptions; private and group targets; a Qzone draft reaching successful publication; sharing across different source scopes; a publishing timeout after possible remote success; continuing an activity after context compaction; and life mode being off. Permitted silence should not uniformly count as failure. For autonomous scenarios, assess reasons, appropriateness, and the completion chain rather than requiring action every time.

**Relationship to ADRs:** adding operating knowledge and skill loading is consistent with [ADR-0010](../adr/0010-expose-native-snowluma-actions.md) as long as all enabled native APIs remain directly available. A separate proposal to expose API schemas to the model only after a skill is loaded would require explicitly revisiting that ADR. Separate decision-making subjects per group or skill would conflict with [ADR-0001](../adr/0001-one-agent-across-group-environments.md) and [ADR-0002](../adr/0002-single-attention-with-continuous-perception.md); these recommendations require no such change. Unknown outcomes continue to follow [ADR-0008](../adr/0008-preserve-unknown-action-outcomes.md).

This research only added an investigation record. It did not implement skill loading, modify existing runtime code, or perform real QQ operations. The source structure of external projects does not establish reproducible results with Luo Qiuyue's model; the scenario validation above is still needed.

