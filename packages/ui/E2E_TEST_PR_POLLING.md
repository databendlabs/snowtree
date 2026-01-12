# E2E Test Script: PR Polling and Creation Workflow

## Purpose
Verify that PR information displays correctly in the right panel after creation, and that the polling mechanism detects PR state changes.

## Prerequisites
- Snowtree application running (`pnpm dev`)
- A test repository with:
  - Git initialized
  - GitHub remote configured
  - `gh` CLI authenticated
  - Write access to create PRs

## Test Setup

### 1. Prepare Test Repository
```bash
# Create a test workspace in Snowtree
# Select a repository with GitHub remote

# Verify gh CLI is working
gh auth status

# Check current branch and remote
git status
git remote -v
```

## Test Cases

### Test Case 1: PR Creation Detection
**Objective**: Verify that creating a PR makes it appear in the right panel within 5 seconds

**Steps**:
1. Start with a clean state (no existing PR for the branch)
2. Make a small code change:
   ```bash
   echo "// Test change" >> test.txt
   git add test.txt
   git commit -m "test: E2E PR polling test"
   ```
3. Push the branch:
   ```bash
   git push -u origin $(git branch --show-current)
   ```
4. Create a PR via Snowtree UI:
   - Click the "Sync" or "Push & PR" button in the right panel
   - Let the AI execute `gh pr create` command
   - Verify the AI successfully creates the PR
5. **Observe the right panel**:
   - Within 5 seconds, the PR section should appear
   - Should show: PR number, URL, and merged status (false)

**Expected Result**:
- ✅ PR information displays in right panel within 5 seconds
- ✅ PR number matches the created PR
- ✅ PR URL is clickable and correct
- ✅ Merged status shows as "false"

**Debugging**:
- Check browser console for errors
- Verify API call logs: `getRemotePullRequest` should be called every 5 seconds
- Check that polling timer is active (should see periodic API calls)

---

### Test Case 2: PR Update Detection
**Objective**: Verify that merging a PR updates the right panel

**Prerequisites**: Test Case 1 completed with PR created

**Steps**:
1. Open the PR in GitHub web interface
2. Merge the PR on GitHub
3. Wait 5 seconds
4. **Observe the right panel**:
   - Merged status should update to "true"
   - PR information should remain visible

**Expected Result**:
- ✅ Within 5 seconds, merged status changes to "true"
- ✅ PR URL and number remain the same
- ✅ No errors in console

---

### Test Case 3: PR Deletion Detection
**Objective**: Verify that closing/deleting a PR removes it from the right panel

**Prerequisites**: Test Case 1 completed with PR created

**Steps**:
1. Close the PR on GitHub (without merging)
2. Wait 5 seconds
3. **Observe the right panel**:
   - PR section should disappear or show "No PR"

**Expected Result**:
- ✅ Within 5 seconds, PR information is removed from right panel
- ✅ No errors in console

---

### Test Case 4: Polling Continuous Operation
**Objective**: Verify polling runs continuously every 5 seconds

**Steps**:
1. Open browser DevTools → Network tab
2. Filter for API calls containing "getRemotePullRequest" or "remote-pull-request"
3. Observe for 30 seconds
4. Count the number of API calls

**Expected Result**:
- ✅ API calls occur approximately every 5 seconds
- ✅ Should see ~6 calls in 30 seconds (1 immediate + 5 interval calls)
- ✅ Calls continue even if no PR exists

---

### Test Case 5: Session Switch Cleanup
**Objective**: Verify polling restarts correctly when switching workspaces

**Prerequisites**: At least 2 workspaces/sessions in Snowtree

**Steps**:
1. Start with Session A active
2. Verify polling is running (check DevTools Network tab)
3. Switch to Session B
4. Verify polling continues for Session B
5. Switch back to Session A
6. Verify polling resumes for Session A

**Expected Result**:
- ✅ Polling stops for inactive session
- ✅ Polling starts immediately for newly active session
- ✅ No memory leaks (old timers are cleaned up)
- ✅ Each session polls independently

---

### Test Case 6: Full Workflow Integration
**Objective**: Test the complete workflow from commit to PR creation to display

**Steps**:
1. Start with uncommitted changes in the workspace
2. Stage changes using Snowtree UI or git command
3. Click "Commit" button in right panel
   - Let AI execute `git commit` command
4. Click "Sync" or "Push & PR" button
   - Let AI execute `git push` and `gh pr create` commands
5. **Observe right panel throughout**:
   - Before push: No PR shown
   - After PR creation: PR appears within 5 seconds
   - PR information is accurate and clickable

**Expected Result**:
- ✅ Commit succeeds
- ✅ Push succeeds
- ✅ PR is created successfully
- ✅ PR appears in right panel within 5 seconds
- ✅ PR information is correct (number, URL, merged=false)

---

## Verification Checklist

After running all test cases, verify:

- [ ] PR creation is detected within 5 seconds
- [ ] PR updates (merge status) are detected within 5 seconds
- [ ] PR deletion is detected within 5 seconds
- [ ] Polling runs continuously every 5 seconds
- [ ] Polling works even when no PR exists (this was the original bug)
- [ ] Switching sessions properly cleans up old polling timers
- [ ] No console errors during any test case
- [ ] No memory leaks (check DevTools Memory/Performance tab)

## Debugging Tips

### If PR doesn't appear:
1. Check browser console for errors
2. Verify `gh pr view` command works in terminal:
   ```bash
   gh pr view --json number,url,state,merged
   ```
3. Check API logs in Snowtree backend
4. Verify `getRemotePullRequest` API is being called (DevTools Network tab)
5. Check that `prPollingTimerRef` is set (not null) in React DevTools

### If polling stops:
1. Check if `sessionId` changed unexpectedly
2. Verify useEffect cleanup didn't run prematurely
3. Check for JavaScript errors that might have crashed the component
4. Verify interval timer exists: `prPollingTimerRef.current !== null`

### Performance checks:
1. Polling should not cause UI lag
2. Memory usage should remain stable over time
3. API calls should not pile up (no concurrent calls)

## Success Criteria

**All 6 test cases pass** AND **all verification checklist items are checked**

## Related Files

- Implementation: `packages/ui/src/components/layout/useRightPanelData.ts:418-466`
- Unit tests: `packages/ui/src/components/layout/useRightPanelData.test.tsx:103-313`
- UI component: `packages/ui/src/components/layout/MainLayout.tsx:211-266`

## Test Results Log

**Date**: _________
**Tester**: _________
**Application Version**: 1.0.28

| Test Case | Status | Notes |
|-----------|--------|-------|
| 1. PR Creation Detection | ⬜ Pass / ⬜ Fail | |
| 2. PR Update Detection | ⬜ Pass / ⬜ Fail | |
| 3. PR Deletion Detection | ⬜ Pass / ⬜ Fail | |
| 4. Polling Continuous | ⬜ Pass / ⬜ Fail | |
| 5. Session Switch Cleanup | ⬜ Pass / ⬜ Fail | |
| 6. Full Workflow Integration | ⬜ Pass / ⬜ Fail | |

**Overall Result**: ⬜ All tests passed ⬜ Some tests failed

**Additional Notes**:
```



```
