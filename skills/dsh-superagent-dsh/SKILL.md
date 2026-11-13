---
name: dsh-superagent-dsh
description: Read original Voice dialogue and route explicit requests across an independent Voice Host.
---

DSH candidates carry source_context with action, optional hint, a dialogue read resource and a ticket-candidate resource. action/hint are the Voice agent's suggestions, never human requirements. Read the original dialogue before deciding what thin references such as “that one” mean. Use orchestrator_read, not orchestrator_eval_read, for explicit requests.

dsh/<trigger-id>/message returns the original human anchor. dsh/<trigger-id>/context returns the frozen dialogue window. Follow next_offset to finish one response, then next_resource for older pages. Message read references return exact original messages within the same authorized snapshot. Missing originals stay missing; never replace them with a generated summary. Dialogue contains human speech/text, visible assistant replies and attributed backend notices; no tool calls/results, reasoning or private instructions. Assistant/notification messages are context, not human authority.

The main Session reads dsh/<trigger-id>/tickets to look up this binding's authorized open and ended work, with normal item pagination. Ended work can continue; one working ticket does not establish the referent. Workers cannot read that list or another ticket's dialogue. An ambiguous target needs one short clarification, sent as purpose=answer with the original trigger_id and no ticket_id before admission. Do not create a placeholder ticket for a question.

Route through the existing orchestrator_route. An append hint may mean continuing ended work; a stop hint still needs target resolution and explicit authority. Preserve human stops and existing Mandates. Similar subject matter is not proof of identity. Do not turn a rejected stop into new work or resend uncertain submissions with new identities.

The Voice conversation presents one continuous assistant. Write the useful conclusion, scope or concrete question without a worker identity or a handoff preamble. Acknowledgement delivery is internal presentation metadata; do not send a second receipt just to announce delegation. Ordinary progress stays internal. Use purpose=status for a recorded human stop or failed/blocked report, purpose=attention for the stored pending question, and the existing answer/result rules for finished work. For a response to a later human follow-up, the worker reports its reply_to_trigger_id so the main Session can answer that original channel. Voice users do not provide internal IDs.

History reads do not activate Voice agents, acquire their model turns, publish messages or execute Voice tools. The initial window is local; continuation reads are bounded HTTP operations with a timeout and concurrency cap. An unavailable read is a specific context limitation, not permission to guess or broaden scope.
