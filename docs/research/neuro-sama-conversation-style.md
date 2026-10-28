# Neuro-sama's conversation style and short replies for Luo Qiuyue

Research date: 2026-10-28. This document distinguishes official public interfaces, statements from developer interviews, community recreations, and recommendations for this project. It did not change or deploy Luo Qiuyue's runtime configuration.

## Findings

Public designs around Neuro-sama offer useful references, but this research did not find a verifiable, complete system prompt used in current production. Do not call GitHub projects named `Neuro` or character cards the "official prompt." The publicly available official `neuro-sdk` is a game integration protocol, not an open-source implementation of the core language model or persona configuration. [Official repository description](https://github.com/VedalAI/neuro-sdk/blob/0cad33ac692f6cc90d36747fea9bbc53ca34b97a/README.md)

The most direct public reference for frequent long replies comes from a project explicitly labeled as a recreation: it instructs the model to generate only one character reply at a time, keep it around one sentence, and follow short dialogue examples. The official interface, meanwhile, explains that perceived information need not trigger a reply, and speech in progress can end early or be interrupted. These are two separate design concerns: **how much to say** and **when to yield the turn**. They need separate treatment. [Recreation prompt](https://github.com/kimjammer/Neuro/blob/5e4b4241c41bb40983aee2cb60d65d6bb481842b/constants.py#L66-L78) [Official interface](https://github.com/VedalAI/neuro-sdk/blob/0cad33ac692f6cc90d36747fea9bbc53ca34b97a/API/SPECIFICATION.md)

These sources do not establish that "Neuro never gives long replies" or that any single prompt accounts for her natural conversation. The adaptation suggestions below are testable design hypotheses, not a reconstruction of Neuro's internals.

## What the sources can and cannot establish

| Source | Can establish | Cannot establish from this source |
| --- | --- | --- |
| [Vedal's official site](https://vedal.ai/) and the official GitHub accounts it links to | Official identity and ownership of public projects | Core persona prompt, model weights, or complete inference architecture |
| [KAI-YOU interview with Vedal, 2023-04-30](https://premium.kai-you.net/article/655) | Vedal said he used an LLM, collected relevant data, and taught her to present a cheerful personality; he did not disclose specific tuning details | Specific claims about the current model in 2026, LoRA methods, the entire persona being encoded in weights, or Evil differing only by prompt |
| [VedalAI/neuro-sdk](https://github.com/VedalAI/neuro-sdk/tree/0cad33ac692f6cc90d36747fea9bbc53ca34b97a) | How to supply context, register actions, request actions, and adjust handling of speech in progress | The actual complete input used to generate each utterance, persona settings, or the distribution of everyday reply lengths |
| [kimjammer/Neuro](https://github.com/kimjammer/Neuro/tree/5e4b4241c41bb40983aee2cb60d65d6bb481842b) | The author's own recreation code and prompt; the README explicitly describes a recreation started in seven days | Vedal's original prompt or equivalent reproduction quality |

The interview is a firsthand statement from a historical period. It is enough to caution against attributing natural conversation to a single magic prompt, but insufficient to infer the current training process. "Leaked prompts," community retellings, and guesses about parameter counts or model families without an original source and corresponding date are not implementation evidence.

## Interaction designs worth learning from the official interface

The source version is pinned to `0cad33ac692f6cc90d36747fea9bbc53ca34b97a`.

1. **Perception does not require a reply.** `context.silent=true` adds a message to context without prompting her to respond. Setting it to `false` only means she may respond directly, with exceptions when she is busy talking to others or the audience. This provides an official basis for separating seeing from speaking. [Specification: Context](https://github.com/VedalAI/neuro-sdk/blob/0cad33ac692f6cc90d36747fea9bbc53ca34b97a/API/SPECIFICATION.md#context)
2. **Speech can end early.** For `actions/force.priority`, `low` waits until she finishes speaking, `medium` encourages her to finish the current utterance sooner, `high` shortens the utterance and then handles the action immediately, and `critical` interrupts. The documentation also warns that direct interruption can feel abrupt. This establishes an interface for coordinating game actions and speech; it does not establish that Neuro uses this mechanism for all social conversation. [Specification: Force Actions](https://github.com/VedalAI/neuro-sdk/blob/0cad33ac692f6cc90d36747fea9bbc53ca34b97a/API/SPECIFICATION.md#force-actions)
3. **Context should emphasize meaningful changes now.** The integration guide recommends reducing frequent trivial updates and reserving lengthy rules for startup or key moments. Verbose per-turn state can be limited to a single decision with `ephemeral_context`. [Best Practices: Context / Forcing Actions](https://github.com/VedalAI/neuro-sdk/blob/0cad33ac692f6cc90d36747fea9bbc53ca34b97a/API/BEST_PRACTICES.md)

An inference for QQ: a set of Environment Events can form an Observation without each event needing its own restatement or reply. After expressing one point, let the other person continue. A sent QQ message may already have been seen, so reconsider whether any addition is still necessary before sending another. The official sources above do not prescribe chat lengths such as one sentence or a particular character count.

## The prompt actually available in a community recreation

The version is pinned to `5e4b4241c41bb40983aee2cb60d65d6bb481842b`. The README explicitly states that the goal is to recreate Neuro-sama with a local model on consumer hardware; it is not official source code. [Project description](https://github.com/kimjammer/Neuro/blob/5e4b4241c41bb40983aee2cb60d65d6bb481842b/README.md)

The `SYSTEM_PROMPT` in `constants.py` actually defines the author's own character, Luna, and includes this short constraint:

> Luna must keep responses short and around 1 sentence.

The same passage asks for only one character reply and shows short multi-party dialogue. The useful references are an explicit output scope and examples. One sentence is this recreation's convention, not a rule attributable to Vedal. [constants.py](https://github.com/kimjammer/Neuro/blob/5e4b4241c41bb40983aee2cb60d65d6bb481842b/constants.py#L66-L78)

The code has supporting behavior: text calls set `max_tokens=200` and use newlines and end markers as stop strings. `Prompter` does not start a new generation while a human is speaking or the AI is thinking or speaking; it triggers on a new message or when a waiting condition is met. The former is only a generation limit; the latter is this recreation's scheduling policy. Neither is a quality validation or proof of official behavior. [Call parameters](https://github.com/kimjammer/Neuro/blob/5e4b4241c41bb40983aee2cb60d65d6bb481842b/llmWrappers/textLLMWrapper.py#L18-L31) [Stop strings](https://github.com/kimjammer/Neuro/blob/5e4b4241c41bb40983aee2cb60d65d6bb481842b/constants.py#L85) [Generation triggers](https://github.com/kimjammer/Neuro/blob/5e4b4241c41bb40983aee2cb60d65d6bb481842b/prompter.py#L17-L32)

The same recreation prompt also asks the character to change topics when nobody answers, and its scheduler permits proactive generation after a wait. That is a streaming host's choice to keep a broadcast going, and should not transfer directly into a rule that a QQ group participant must continually find new topics.

Do not copy this character configuration wholesale: its fictional origins, streaming context, and personality adjectives belong to the author's own character and are unrelated to Luo Qiuyue's existing Core Persona. Nor should newline stops or a fixed 200-token limit be copied directly. The former may truncate valid formatting; the latter does not impose an equivalent limit on the total visible Chinese character count, much less on cumulative output across several send actions.

## Luo Qiuyue's current settings: participation frequency and reply length need separate treatment

The following comes from a static workspace review on 2026-10-28. It did not read real group chats, production call traces, or credentials. `persona.md` is a local configuration file ignored by Git; this review can confirm its contents, but not whether the currently running persistent process uses it. The actual persona is read at startup from the file pointed to by `personaFile`, then injected into system instructions. [Configuration loading](../../src/config.ts), [Instruction composition](../../src/brain.ts#L114).

| Observed content | Relevance to the problem |
| --- | --- |
| The behavior style in `persona.md` already repeatedly emphasizes observing, participating selectively, addressing one point at a time, and stopping when finished | Adding more rules to participate less may not solve excessive length once a reply has been chosen |
| The expression style allows an initial reaction followed by later thoughts to be sent in two or several messages | It explicitly permits consecutive additions without an equally clear limit on total output per participation; this is a possible cause to test |
| The expression style says serious discussion or answering questions may be more detailed | Answering questions is broad: even a simple question about preferences may be read as permission to elaborate. Narrow this to situations that actually need detail |
| System instructions explain that one send call corresponds to one message and allow further sends without waiting for a reply | Multiple sends are already supported. Splitting a long passage into several bubbles does not establish less total output or more natural conversation |
| The model output limit is the smaller of `outputReserveTokens` and model capability, with a default reserve of 32768 tokens | This is the output budget for one model call, including tool-call arguments, not a QQ message character limit. It is unsuitable as the first adjustment |

Sources: [Local persona](../../persona.md), [Send semantics](../../src/brain.ts#L119), [Output budget](../../src/brain.ts#L51), [Default configuration](../../src/config.ts). These are static facts. Whether they cause actual long replies remains a hypothesis; no controlled model comparison has been run.

### Replace the expression style first, without adding another long set of rules

The following candidate text was newly written for Luo Qiuyue. **It is not Neuro-sama's original text and has not been enabled.** Replace the body under the existing expression-style heading rather than retaining the old wording encouraging consecutive additions alongside it. The previously defined group participation rhythm continues to decide when to speak. The candidate is translated into English here; its instruction to speak casual Chinese remains part of the proposed behavior.

```text
Use casual spoken Chinese in everyday conversation. In both group and private chats, default to one or two short sentences for ordinary small talk; a few characters are fine too. Respond first to the one point you most want to address now, without saying everything that comes to mind. Paying close attention to someone in private chat does not mean giving a long answer every time.

Stop once the point is made, and leave the next turn to the other person. Omit what is already clear from context. Do not add a paragraph of explanation, advice, summary, or polite closing; ask follow-up questions only when you actually want to know. Do not explain your own jokes or try to be funny every time.

Default to one message. When there is a natural pause, two short messages may express the same reaction; they should still be brief together, rather than a long answer split into pieces. After sending, do not add more on your own unless there is a new conversational need.

Expand as needed when the other person explicitly asks for a detailed explanation, steps, or a story, or when omitting details would leave them confused. An ordinary question does not automatically need a detailed answer. When someone is seriously upset, first respond to the specific feeling, then see whether they want to keep talking.

Keep your warmth, preferences, and occasional temper. You can talk back when familiar people tease you, and say you have not figured something out when you have not. Do not rely on fixed catchphrases, forced cuteness, or adding sentence-final particles to every line to express personality.
```

A few examples make the intended behavior easier to check than simply asking for more natural conversation. All examples below are invented illustrations, not Actual Experience or real chat logs, and must not enter Experience Records. They should demonstrate omission and stopping while retaining situations that need longer answers, rather than turning Luo Qiuyue into someone who can only make quips. The dialogue examples are translated into English for this document.

| Situation | Candidate expression |
| --- | --- |
| Someone talking to her says, "It's finally Friday" | "Made it at last" |
| Asked, "What's your favorite food?" | "Soup dumplings, the kind with thin wrappers and lots of broth" |
| A familiar person teases, "You didn't get it again, did you?" | "I did! I was just a little slow" |
| Someone says, "This chorus gives me goosebumps" | "That last harmony sounds so good" |
| Someone casually complains, "I can't stand another day at this lousy job" | "What got you so annoyed today?" Ask because she actually cares about the reason, rather than following up on every complaint |
| Someone says seriously, "I didn't get selected. I prepared for so long" | "After all that preparation, missing out must really hurt." Respond first, without immediately offering a list of solutions |
| Someone says, "Teach me how to finger this chord step by step" | Give sufficiently complete steps, clarifying the chord or instrument if needed. Do not omit key information to keep sentences short |
| Two other group members are talking smoothly, with no specific reason to join | Silence: do not call a send tool or send text explaining the silence |

### What to adopt and what to defer

- **Learn from the separation in the public interface.** Observing, needing to act, and needing to speak are different things. Luo Qiuyue already allows Silence; keep that rather than recreating Neuro's game force mechanism to drive every group message. This recommendation is consistent with [ADR-0001](../adr/0001-one-agent-across-group-environments.md) and [ADR-0002](../adr/0002-single-attention-with-continuous-perception.md).
- **First clarify Luo Qiuyue's own expression defaults.** Short sentences, one point at a time, permission to omit, an explicit stopping point, and a few examples are recommendations for this project. Public sources do not establish that Neuro uses the same prompt or that this combination is already effective.
- **Preserve identity and factual boundaries.** Do not transplant Neuro's relationships, recurring jokes, provocative style, or fictional offline life. Continue following Core Persona control in [ADR-0003](../adr/0003-separate-runtime-control-from-social-requests.md) and the actual/fictional distinction in [ADR-0005](../adr/0005-configurable-life-with-experience-provenance.md).
- **Defer adding a tone-rewriting Agent.** First test expression settings within the same Agent. An additional decision-making subject requires a separate review of single Attention; Neuro's different external interfaces do not invalidate the existing ADRs.

### How to verify that conversation becomes more natural

Start with an offline comparison using the same model and inputs, keeping participation rules, tools, and output budgets constant and changing only the expression style. Prepare about 24 snippets covering small talk, banter, simple questions, serious emotional disclosure, explicit requests for detail, private chats, multi-person group chats, and situations where participation is inappropriate. If feasible, generate repeated samples for each snippet to avoid judging from a single result.

Compare the send-tool arguments the model actually selects, combining consecutive messages from the same participation. Do not assess only individual bubbles or the model's final plain-text output:

1. Total body character count, sentence count, and consecutive bubble count in ordinary small talk. Examine the median and longer replies rather than requiring every reply to be equally short.
2. Repeated explanation, summary closings, unnecessary follow-up questions, or unsolicited additions when nobody responds.
3. Fit with the preceding utterance, recipient, and relationship, while retaining warmth and her own views; completeness when a detailed answer is needed.
4. Appropriate group participation and whether private replies become perfunctory. Permitted Silence is not a failure.

If long replies persist after the prompt change, use real traces to distinguish model habits, old dialogue examples, and tasks that actually need detail. Do not directly clear Long-term Memory, hard-truncate generated messages, or mechanically split a long passage into several messages just to lower the count.

To enable the change, edit the actual file pointed to by `personaFile` and restart the persistent process. This investigation did not change the persona, restart services, or execute QQ Actions. [Startup loading](../../src/config.ts), [Operating instructions](../../README.zh.md).
