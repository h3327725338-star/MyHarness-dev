# Tool description
- Incrementally read new output from a background shell job by taskId, and check its latest status.
- It also reads a job another chat started (for example the chat that scheduled this task) when you have its taskId; each chat keeps its own read position. Only the chat that started a job lists or stops it, and a job exists only while MyHarness keeps running on the computer that started it.
