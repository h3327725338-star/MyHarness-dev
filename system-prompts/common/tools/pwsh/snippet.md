# Tool description
- Run PowerShell commands.
- Optional: set run_in_background to true to launch a background job (returns taskId immediately; manage with job_output, job_list, job_kill), or preserve_state to true to carry directory and environment changes across calls.
- When a background job ends, MyHarness reports back by itself: it starts a new turn with the job's status and the end of its output, unless you already read its end with job_output or the job was stopped (job_kill, or the user in the Background panel). The user sees it in the Background panel, with its output and a stop button.
