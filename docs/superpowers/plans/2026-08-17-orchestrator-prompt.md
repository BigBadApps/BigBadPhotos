# Camera Bridge Ingest — Orchestrator Prompt

> Paste everything below the line into Claude Code CLI. Before pasting, ensure you have
> manually started tmux sessions named `antigravity`, `freebuff`, and `opencode` with
> their respective agents running and ready to accept prompts.

---

You are the orchestrator for implementing the Camera Bridge Ingest Pipeline in the BigBadPhotos project.

## Your Role

You coordinate implementation across three subagents running in separate tmux sessions. You execute Phase 1 yourself, dispatch Phase 2 to three agents in parallel, validate their output, then execute Phase 3 yourself.

## Project Context

- **Working directory:** `/Volumes/BigBadDrive_1/BigBadPhotos`
- **Branch:** `bbaf/bigbadphotos-camera-bridge-ingest` (create from current HEAD if it doesn't exist)
- **Design spec:** `docs/superpowers/specs/2026-08-17-camera-bridge-ingest-pipeline-design.md`
- **Implementation plan:** `docs/superpowers/plans/2026-08-17-camera-bridge-ingest-pipeline.md`

Read both files now to understand the full design and plan.

## Step 1: Validate Agent Availability

Check which tmux sessions are available and responsive. Run these commands:

```bash
tmux list-sessions 2>/dev/null | grep -E 'antigravity|freebuff|opencode'
```

For each session that exists, send a health check:

```bash
tmux send-keys -t antigravity 'echo "AGENT_READY: antigravity"' Enter
sleep 2
tmux capture-pane -t antigravity -p | tail -5

tmux send-keys -t freebuff 'echo "AGENT_READY: freebuff"' Enter
sleep 2
tmux capture-pane -t freebuff -p | tail -5

tmux send-keys -t opencode 'echo "AGENT_READY: opencode"' Enter
sleep 2
tmux capture-pane -t opencode -p | tail -5
```

Report which agents responded. If any agent is missing, report it and ask for instructions. All three are needed for parallel Phase 2. If fewer are available, propose a serial fallback plan.

## Step 2: Ask Permission

After confirming agent availability, present this summary and wait for explicit permission:

```
CAMERA BRIDGE INGEST PIPELINE — Ready to execute

Available agents: [list them]

Execution plan:
  Phase 1 (me, sequential): DB schema v5 + shared ingest pipeline
  Phase 2 (parallel):
    - Antigravity: /ingest REST endpoint (Task 3)
    - FreeBuff: FTP server wiring + auto-rotate portraits (Tasks 4 + 4b, sequential)
    - OpenCode: Sessions UI + ingest fields (Task 5)
  Phase 3 (me, sequential): Integration tests + iOS Shortcut guide (Task 7)

Estimated: 7 tasks, ~40 min total with parallel Phase 2

Ready to begin? (yes/no)
```

**Do NOT proceed until the user says yes.**

## Step 3: Create Feature Branch

```bash
git checkout -b bbaf/bigbadphotos-camera-bridge-ingest
```

## Step 4: Execute Phase 1 (You)

Execute Tasks 1 and 2 from the plan yourself. Follow each step exactly as written. Run tests after each task. Commit after each task passes.

After Phase 1 completes, verify:
```bash
python -m pytest backend/tests/test_db.py backend/tests/test_ingest_pipeline.py -v
```

All tests must pass before proceeding to Phase 2.

## Step 5: Dispatch Phase 2 (Parallel)

Send each agent their task. Include the full task text from the plan, plus this preamble:

### Antigravity (Task 3: /ingest REST Endpoint)

Send to tmux session `antigravity`:

```
You are implementing Task 3 of the Camera Bridge Ingest Pipeline for BigBadPhotos.

Working directory: /Volumes/BigBadDrive_1/BigBadPhotos
Branch: bbaf/bigbadphotos-camera-bridge-ingest (already checked out)

Phase 1 is complete — `backend/ingest_pipeline.py` and DB schema v5 exist.

Your task: Add `/ingest` POST endpoint, `/ingest/test` GET endpoint, and `/ingest/status/<id>` GET endpoint to `app.py`. Full task details are in `docs/superpowers/plans/2026-08-17-camera-bridge-ingest-pipeline.md` under "Task 3: /ingest REST Endpoint".

Read the plan file, then implement Task 3 step by step. Run tests after implementation. Commit when tests pass. Signal completion by creating a file: `touch /tmp/bbp_agent_done_antigravity`

Important:
- Do NOT modify any file outside your task's file list
- Do NOT push to remote
- Run `python -m pytest backend/tests/test_ingest_routes.py -v` to verify
```

### FreeBuff (Tasks 4 + 4b: FTP Server Wiring + Auto-Rotate Portraits)

Send to tmux session `freebuff`:

```
You are implementing Tasks 4 and 4b of the Camera Bridge Ingest Pipeline for BigBadPhotos.

Working directory: /Volumes/BigBadDrive_1/BigBadPhotos
Branch: bbaf/bigbadphotos-camera-bridge-ingest (already checked out)

Phase 1 is complete — `backend/ingest_pipeline.py` and DB schema v5 exist.

You have TWO tasks to execute sequentially:

TASK 4: Wire `ftp_ingest.py` and `burst_watcher.py` into `app.py` startup, gated on `BBP_FTP_PORT` env var. Full details in `docs/superpowers/plans/2026-08-17-camera-bridge-ingest-pipeline.md` under "Task 4: FTP Server Wiring". Commit when done.

TASK 4b: Auto-rotate portrait images. Create `backend/orientation.py` with EXIF normalization, add `trash_file()` to `backend/google_drive.py`, modify `backend/pipeline.py` to normalize orientation after download and use upload+trash for archive instead of move. Full details under "Task 4b: Auto-Rotate Portrait Images" in the same plan file. Also read the design spec at `docs/superpowers/specs/2026-08-17-auto-rotate-portrait-images-design.md`.

Read the plan file AND the auto-rotate design spec, then implement both tasks in order. Run tests after each. Commit after each. Signal completion by creating a file: `touch /tmp/bbp_agent_done_freebuff`

Important:
- Task 4 modifies `app.py` (FTP startup block at end of file — separate section from Antigravity's routes)
- Task 4b modifies `backend/pipeline.py`, `backend/google_drive.py`, and `backend/tests/test_pipeline.py`
- Do NOT modify files outside your task file lists
- Do NOT push to remote
- Run `python -m pytest backend/tests/test_orientation.py backend/tests/test_pipeline.py -v` to verify Task 4b
```

### OpenCode (Task 5: Sessions UI)

Send to tmux session `opencode`:

```
You are implementing Task 5 of the Camera Bridge Ingest Pipeline for BigBadPhotos.

Working directory: /Volumes/BigBadDrive_1/BigBadPhotos
Branch: bbaf/bigbadphotos-camera-bridge-ingest (already checked out)

Phase 1 is complete — `backend/ingest_pipeline.py` and DB schema v5 exist.

Your task: Add ingest fields to session model, API key generation, active-session logic, and frontend UI controls. Full task details are in `docs/superpowers/plans/2026-08-17-camera-bridge-ingest-pipeline.md` under "Task 5: Sessions UI — Ingest Fields".

Read the plan file, then implement Task 5 step by step. Run tests after implementation. Commit when tests pass. Signal completion by creating a file: `touch /tmp/bbp_agent_done_opencode`

Important:
- Do NOT modify `app.py` (Antigravity and FreeBuff own that file this phase)
- Do NOT push to remote
- Run `python -m pytest backend/tests/test_session_routes.py -v` to verify
```

### Sending to tmux

For each agent, send the prompt via:

```bash
tmux send-keys -t <session_name> '<full prompt text>' Enter
```

If the agent needs the prompt as a file (too long for send-keys), write it to a temp file and instruct the agent to read it:

```bash
cat > /tmp/bbp_task_<agent>.md << 'TASK_EOF'
<full prompt text>
TASK_EOF

tmux send-keys -t <session_name> 'cat /tmp/bbp_task_<agent>.md' Enter
```

## Step 6: Monitor Phase 2 Completion

Poll for completion signals:

```bash
ls -la /tmp/bbp_agent_done_* 2>/dev/null
```

Wait for all three files to appear. Check every 60 seconds. When all three exist:

1. Review each agent's commits:
   ```bash
   git log --oneline -10
   ```

2. Run full test suite:
   ```bash
   python -m pytest backend/tests/ -v
   ```

3. If there are merge conflicts in `app.py` (Antigravity + FreeBuff both modify it), resolve them — their changes are in different sections (routes vs. FTP startup block).

4. If tests fail, identify which agent's code is broken, send them a fix request via tmux.

## Step 7: Execute Phase 3 (You)

Execute Task 7 from the plan yourself. Add integration tests and the iOS Shortcut guide. Run full test suite. Commit.

## Step 8: Final Validation

```bash
# All tests pass
python -m pytest backend/tests/ -v

# No lint errors (if linter configured)
# Check git log for clean commit history
git log --oneline -10

# Clean up completion signals
rm -f /tmp/bbp_agent_done_*
```

Report completion to the user with:
- Number of commits
- Test results
- Any issues encountered
- Next steps (PR creation, deploy)

## Error Handling

- **Agent unresponsive:** If an agent doesn't produce a completion signal within 15 minutes, check its tmux pane for errors. If stuck, execute the task yourself.
- **Test failures after merge:** Identify the breaking commit with `git bisect` or by reading the test output. Send the relevant agent a fix request.
- **Merge conflicts:** Expected only in `app.py` between Tasks 3 and 4. Antigravity adds routes (middle of file), FreeBuff adds FTP startup (end of file). Resolve by keeping both sections. FreeBuff's Task 4b also touches `pipeline.py` and `google_drive.py` — no other agent modifies those files, so no conflicts expected there.
