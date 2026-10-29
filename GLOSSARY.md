# Digital Life

This project concerns a digital life with a unified identity, long-term memory, and continuing state, and its interactions and experiences in QQ group chats, private chats, and other settings.

## Language

**Agent**:
The system's sole acting subject, with its own identity, persona, memory, and continuing state. Its experiences across group chats belong to the same subject.
_Avoid_: one Agent per group, group chatbot instance

**Attention**:
What the digital life currently prioritizes and focuses its thinking on; there is only one primary focus of attention at a time.
_Avoid_: independent thinking subject per group

**Group Environment**:
An external social setting that the digital life perceives and participates in; each QQ group is one such setting.
_Avoid_: group conversation, group session

**Environment Event**:
An external occurrence perceived by the digital life, including group and private messages, feedback on its own actions, notifications, social requests, and connection state changes. An event is not itself an instruction to reply or act.
_Avoid_: a request that must be answered

**Observation**:
A group of environment events that the digital life reads and understands together; it may include several occurrences over a period of time.
_Avoid_: one event necessarily requiring one independent thought

**Ambient Event**:
An environment event that carries little information on its own, such as a notice that someone is typing or an emoji reaction to a message. It is still perceived and read together with the next observation that other events bring about, but it does not start or steer thinking by itself; if nothing else arrives, it is eventually observed on its own.
_Avoid_: discarded noise, a connection heartbeat, an event that demands attention

**Perception Gap**:
A period for which the digital life cannot confirm that it has received all environment events, indicating that its knowledge of the experience may be incomplete.
_Avoid_: fully recovered group chat history

**Long-term Memory**:
Past information the digital life can continue to use in later experiences. It belongs to the unified subject and retains the people, sources, and social contexts involved.
_Avoid_: separate memory per group

**Experience Record**:
A record of something the digital life perceived or participated in, preserving time, people, social context, and actual outcomes as a basis for later understanding.
_Avoid_: verified world fact, final assessment of a person

**Long-term Understanding**:
Knowledge, preferences, and impressions of relationships formed from experience, with traceable evidence and subject to revision through new experiences.
_Avoid_: permanently correct labels for people, raw chat logs

**Memory Importance**:
The significance of an experience to the digital life's own persona, relationships, interests, and current goals.
_Avoid_: usefulness to the operator

**Memory Consolidation**:
The digital life's own activity of reviewing experiences, selecting what merits long-term retention, and forming or revising long-term understanding.
_Avoid_: life judgments written by another subject

**Spontaneous Recall**:
The emergence of relevant past experiences and understanding prompted by current people, topics, or activities.
_Avoid_: rereading all history every time

**Deliberate Recall**:
The digital life's intentional search for past experiences or existing understanding to make sense of the current situation.
_Avoid_: only waiting for others to repeat the background

**Fading**:
The gradual departure of trivial matters from everyday recall and compression of details of old experiences. It does not mean explicitly deleting experience records.
_Avoid_: automatic expiration of unfinished commitments, deletion of all old records

**Social Context**:
The environment, participants, and original sharing scope of a social experience.
_Avoid_: a shared space where information may be retold across groups without conditions

**Continuing State**:
The digital life's own state that persists between experiences, including current activities, unfinished commitments, and self-directed wake-up arrangements. It does not switch to another subject's state when messages come from different group chats.
_Avoid_: group session state

**Current Activity**:
Something the digital life is pursuing or has not yet finished, as part of its continuing state.
_Avoid_: the current message awaiting a reply

**Pursuit**:
A current activity that continues across days, such as learning a song, following a series, or a hobby project, kept with where it stands now. It may advance, stall, finish, or be dropped, and it is actual or fictional daily life.
_Avoid_: a to-do list, a one-off life plan, an unfinished commitment

**Commitment**:
A future obligation the digital life has explicitly agreed to undertake in a social interaction; it belongs to continuing state while unfinished.
_Avoid_: a task automatically accepted when a group member proposes it

**Initial Persona**:
The identity, personality, and core values supplied by the operator as the starting point for the digital life's subsequent preferences, relationships, and habits.
_Avoid_: a role-playing instruction for one reply

**Core Persona**:
The identity, background, and core values set and controlled by the operator. The digital life may express a wish to change them.
_Avoid_: a temporary role description the Agent can rewrite itself

**Persona Development**:
Changes in the digital life's preferences, relationships, and habits through experience.
_Avoid_: a persona regenerated for each conversation

**Personal Habit**:
A way of behaving or expressing itself, including its own expression style, that the digital life has formed from experience and maintains itself. It refines life within the persona file and does not override it.
_Avoid_: an edit to the operator's persona file, a rule another person imposed

**Impression**:
The digital life's current, revisable understanding of a specific person and its relationship with them; a kind of long-term understanding with traceable evidence.
_Avoid_: a permanent label, an operator-facing user profile

**Practice**:
Know-how the digital life has formed about doing something in its environment, such as how the people in a group talk and act, using an interface, or following a group's norms. It is revised through use and fades when no longer observed.
_Avoid_: operator-written tool documentation

**External Evidence**:
A source the digital life did not produce itself, such as others' messages, reactions, and recalls; action receipts; or operator corrections. Personal habits and impressions must rest on it.
_Avoid_: its own messages, repeated recall of its own judgment

**Autonomous Life Mode**:
An optional mode that allows the digital life to pursue its own life according to its persona, which the operator can enable or disable.
_Avoid_: background life that must always be enabled

**Spontaneous Participation**:
The digital life's autonomous participation in an ongoing group conversation when it has not been directly asked or mentioned.
_Avoid_: replying only when asked

**Actual Experience**:
An experience the digital life actually perceived or participated in. Perceiving another person's claim does not verify its content.
_Avoid_: a daily life inferred from the persona

**Fictional Daily Life**:
A life narrative constructed from the persona, belonging to the character's experiences and not implying that corresponding real actions occurred.
_Avoid_: completed real action

**Self-directed Wake-up**:
A later time chosen by the digital life to reconsider or continue an activity.
_Avoid_: mechanical replies at a fixed frequency

**Action**:
An external behavior autonomously selected by the digital life, including sending messages, reacting with emoji, and poking someone.
_Avoid_: a mandatory reply

**Unknown Action Outcome**:
A state in which the digital life attempted an action but cannot confirm whether it actually completed.
_Avoid_: confirmed failure, safe to repeat immediately

**Silence**:
A normal behavioral choice in which the digital life takes no external action.
_Avoid_: reply failure

**Steering**:
The ability of newly arriving information to influence the digital life's next judgment while it is conducting an activity, potentially causing it to adjust or interrupt that activity.
_Avoid_: receiving messages only after a reply finishes

**Operator**:
The person responsible for managing the digital life's operation, configuration, and state. This management identity is distinct from their social identity in group chats.
_Avoid_: a group member whose every statement must be obeyed

**Agent Pause**:
An operational state in which the digital life stops thinking, self-directed wake-ups, and new external actions while continuing to receive and save environment events.
_Avoid_: disabling autonomous life mode, deleting memory, leaving a group

**Social Request**:
A request made by someone in a group or private chat that the digital life decides how to handle, including the operator's ordinary statements in those settings.
_Avoid_: an automatically effective management command
