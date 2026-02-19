 
let tasks = [], current = null, paused = true, tick = null;
let sessionStartTimestamp = null, sessionEndTimestamp = null;
let totalFocusedSeconds = 0, editingIndex = null;
let sessionActive = false, taskRunning = false;
let sessionStartTime = null;
let pausedDuration = 0;
let lastPauseStart = null;
let taskRunStartTime = null;

// ==== PULSE SYSTEM STATE (ADDITIVE) ====
let pulseTimer = null;
let pulseLog = [];
let lastPulseAt = null;
let activePulse = null;

let pendingSessionEnd = false;

let uiScreen = 'manage';
let completionInFlight = false;
const FOCUS_COMPLETE_ANIM_MS = 450;
let focusEntryInFlight = false;
let timelineMode = 'view';
let timelineTaskIndex = null;
let completionPendingEndEntry = null;
let completionPendingEndTaskIndex = null;
let suppressTaskClick = false;
const dragState = {
  active: false,
  fromIndex: null,
  placeholder: null,
  draggedRow: null,
  pointerActive: false,
  pointerId: null,
  moved: false,
  startX: 0,
  startY: 0
};

const $ = id => document.getElementById(id);

function setScreen(mode) {
  const focus = $('focusScreen');
  const manage = $('manageScreen');
  if (!focus || !manage) return;
  const target = taskRunning ? 'focus' : mode;
  uiScreen = target === 'focus' ? 'focus' : 'manage';
  focus.classList.remove('active');
  manage.classList.remove('active');
  if (uiScreen === 'focus') {
    focus.classList.add('active');
  } else {
    manage.classList.add('active');
  }
}

function beginFocusEntryTransition() {
  if (focusEntryInFlight) return;
  const overlay = $('focusEntryOverlay');
  if (!overlay) {
    setScreen('focus');
    return;
  }
  focusEntryInFlight = true;
  overlay.classList.add('active');
  setTimeout(() => {
    setScreen('focus');
    overlay.classList.remove('active');
  }, 170);
  setTimeout(() => {
    focusEntryInFlight = false;
  }, 350);
}

function syncScreenRoute() {
  if (taskRunning) {
    if (uiScreen !== 'focus') {
      beginFocusEntryTransition();
      return;
    }
    setScreen('focus');
    return;
  }
  if (!sessionActive) {
    setScreen('manage');
    return;
  }
  setScreen(uiScreen);
}

function isOverlayVisible(id) {
  const el = $(id);
  return !!el && el.style.display === 'flex';
}

function clearPulseForTransition() {
  if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = null; }
  if (activePulse) {
    if (activePulse.timeout) { clearTimeout(activePulse.timeout); activePulse.timeout = null; }
    if (activePulse.colorTimer) { clearInterval(activePulse.colorTimer); activePulse.colorTimer = null; }
  }
  $('pulseFillLayer')?.classList.remove('active');
  activePulse = null;
  $('pulsePopup').style.display = 'none';
  $('app')?.classList.remove('blurred');
}

function resetPulseScheduler() {
  if (pulseTimer) {
    clearInterval(pulseTimer);
    pulseTimer = null;
  }
}

function startPulseScheduler() {
  resetPulseScheduler();
  if (activePulse && activePulse.timeout) { clearTimeout(activePulse.timeout); activePulse.timeout = null; }
  if (!sessionActive || !taskRunning || current === null || !tasks[current]) return;
  const pulseMinutes = parseInt(tasks[current].pulse, 10) || 0;
  if (pulseMinutes < 5) return;
  pulseTimer = setInterval(() => {
    if (!sessionActive || !taskRunning || current === null || !tasks[current]) return;
    firePulse(tasks[current]);
  }, pulseMinutes * 60 * 1000);
}

function getDragPlaceholder() {
  if (!dragState.placeholder) {
    const ph = document.createElement('div');
    ph.className = 'task-drop-placeholder';
    dragState.placeholder = ph;
  }
  return dragState.placeholder;
}

function placeDragPlaceholder(targetRow, placeAfter) {
  const placeholder = getDragPlaceholder();
  if (!targetRow || !targetRow.parentElement) return;
  const parent = targetRow.parentElement;
  if (placeAfter) {
    parent.insertBefore(placeholder, targetRow.nextSibling);
  } else {
    parent.insertBefore(placeholder, targetRow);
  }
}

function clearDragVisuals() {
  if (dragState.placeholder && dragState.placeholder.parentElement) {
    dragState.placeholder.parentElement.removeChild(dragState.placeholder);
  }
  if (dragState.draggedRow) {
    dragState.draggedRow.classList.remove('task-dragging');
  }
}

function commitTaskReorder(fromIndex, toIndex) {
  if (fromIndex === null || toIndex === null) return;
  if (fromIndex < 0 || fromIndex >= tasks.length) return;
  if (toIndex < 0) toIndex = 0;
  if (toIndex > tasks.length - 1) toIndex = tasks.length - 1;
  if (fromIndex === toIndex) return;

  const activeTaskRef = current !== null ? tasks[current] : null;
  const [moved] = tasks.splice(fromIndex, 1);
  tasks.splice(toIndex, 0, moved);

  if (activeTaskRef) {
    current = tasks.indexOf(activeTaskRef);
  }
}

function resolveDropIndex() {
  const list = $('taskList');
  const placeholder = dragState.placeholder;
  if (!list || !placeholder || !placeholder.parentElement) return dragState.fromIndex;
  const children = Array.from(list.children);
  const placeholderPos = children.indexOf(placeholder);
  if (placeholderPos === -1) return dragState.fromIndex;

  let index = 0;
  for (let i = 0; i < placeholderPos; i++) {
    const el = children[i];
    if (el.classList.contains('task') && !el.classList.contains('task-dragging')) {
      index++;
    }
  }
  return index;
}

function resetDragState() {
  clearDragVisuals();
  dragState.active = false;
  dragState.fromIndex = null;
  dragState.draggedRow = null;
  dragState.pointerActive = false;
  dragState.pointerId = null;
  dragState.moved = false;
}

function finalizeDragDrop() {
  if (!dragState.active || dragState.fromIndex === null) {
    resetDragState();
    return;
  }
  const dropIndex = resolveDropIndex();
  const from = dragState.fromIndex;
  resetDragState();
  commitTaskReorder(from, dropIndex);
  render();
}

function onTaskDragStart(e, index, row) {
  if (!paused) {
    e.preventDefault();
    return;
  }
  dragState.active = true;
  dragState.fromIndex = index;
  dragState.draggedRow = row;
  row.classList.add('task-dragging');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }
}

function onTaskDragOver(e, row) {
  if (!dragState.active || !row || row === dragState.draggedRow) return;
  e.preventDefault();
  const rect = row.getBoundingClientRect();
  const placeAfter = (e.clientY - rect.top) > rect.height / 2;
  placeDragPlaceholder(row, placeAfter);
}

function onTaskDrop(e, row) {
  if (!dragState.active) return;
  e.preventDefault();
  if (row && row !== dragState.draggedRow) {
    const rect = row.getBoundingClientRect();
    const placeAfter = (e.clientY - rect.top) > rect.height / 2;
    placeDragPlaceholder(row, placeAfter);
  }
  finalizeDragDrop();
}

function onTaskDragEnd() {
  finalizeDragDrop();
}

function onTouchPointerMove(e) {
  if (!dragState.pointerActive || e.pointerId !== dragState.pointerId) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  if (!dragState.moved && Math.hypot(dx, dy) < 8) return;

  dragState.moved = true;
  dragState.active = true;
  suppressTaskClick = true;
  if (dragState.draggedRow) dragState.draggedRow.classList.add('task-dragging');

  const el = document.elementFromPoint(e.clientX, e.clientY);
  const row = el ? el.closest('.task') : null;
  if (row && row !== dragState.draggedRow) {
    const rect = row.getBoundingClientRect();
    const placeAfter = (e.clientY - rect.top) > rect.height / 2;
    placeDragPlaceholder(row, placeAfter);
  }
  e.preventDefault();
}

function onTouchPointerEnd(e) {
  if (!dragState.pointerActive || e.pointerId !== dragState.pointerId) return;
  document.removeEventListener('pointermove', onTouchPointerMove, { passive: false });
  document.removeEventListener('pointerup', onTouchPointerEnd);
  document.removeEventListener('pointercancel', onTouchPointerEnd);
  if (dragState.moved) {
    finalizeDragDrop();
  } else {
    resetDragState();
  }
}

function onTaskPointerDown(e, index, row) {
  if (!paused) return;
  if (e.pointerType === 'mouse') return;
  dragState.pointerActive = true;
  dragState.pointerId = e.pointerId;
  dragState.fromIndex = index;
  dragState.draggedRow = row;
  dragState.startX = e.clientX;
  dragState.startY = e.clientY;
  dragState.moved = false;
  document.addEventListener('pointermove', onTouchPointerMove, { passive: false });
  document.addEventListener('pointerup', onTouchPointerEnd);
  document.addEventListener('pointercancel', onTouchPointerEnd);
}

const fmt = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h > 0 ? String(h).padStart(2, '0') + ':' : ''}${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

// Modal UI Logic

let smartTypedDigits = '';
const modalAddIcon = '<svg class="modal-mode-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
const modalEditIcon = '<svg class="modal-mode-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16v4Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path><path d="m12 6 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

function setSmartMaskFromDigits() {
  const full = smartTypedDigits.padStart(6, '0').slice(-6);
  const enteredCount = smartTypedDigits.length;
  const enteredFrom = 6 - enteredCount;
  const isDigitEntered = (digitIdx) => enteredCount > 0 && digitIdx >= enteredFrom;
  const isColonEntered = (colonPos) => {
    if (colonPos === 2) return enteredCount >= 4;
    return enteredCount >= 2;
  };
  const chars = [
    { ch: full[0], entered: isDigitEntered(0) },
    { ch: full[1], entered: isDigitEntered(1) },
    { ch: ':', entered: isColonEntered(2) },
    { ch: full[2], entered: isDigitEntered(2) },
    { ch: full[3], entered: isDigitEntered(3) },
    { ch: ':', entered: isColonEntered(5) },
    { ch: full[4], entered: isDigitEntered(4) },
    { ch: full[5], entered: isDigitEntered(5) }
  ];
  $('smartTimeMask').innerHTML = chars.map(c => `<span class="${c.entered ? 'entered' : 'placeholder'}">${c.ch}</span>`).join('');
  $('smartTimeInput').value = `${full.slice(0, 2)}:${full.slice(2, 4)}:${full.slice(4, 6)}`;
}

function setPulseRangeLabel() {
  const v = parseInt($('pulseRange').value, 10) || 0;
  $('pulseRangeLabel').textContent = v < 5 ? 'OFF' : `${v}m`;
}

$('pulseRange').oninput = setPulseRangeLabel;

// Smart Input
const timeInput = $('smartTimeInput');
timeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Backspace') {
    e.preventDefault();
    smartTypedDigits = smartTypedDigits.slice(0, -1);
    setSmartMaskFromDigits();
  } else if (/^\d$/.test(e.key)) {
    e.preventDefault();
    if (smartTypedDigits.length < 6) {
      smartTypedDigits += e.key;
      setSmartMaskFromDigits();
    }
  } else if (e.key !== 'Tab') {
    e.preventDefault();
  }
});

timeInput.addEventListener('focus', () => {
  const len = timeInput.value.length;
  timeInput.setSelectionRange(len, len);
});
setSmartMaskFromDigits();
setPulseRangeLabel();

function timeToSeconds(str) {
  const p = str.split(':').map(x => parseInt(x) || 0);
  return (p[0] * 3600) + (p[1] * 60) + p[2];
}

function toggleSheet() {
  $('bottomSheet').classList.toggle('active');
  $('sheetOverlay').classList.toggle('active');
}

/// OPEN SHEET FUNCTION ///

function openSheet(type) {
  const title = $('sheetTitle'), body = $('sheetBody');
  if (type === 'focus') {
    title.textContent = "Focus Ratio";
    body.innerHTML = "Formula: <strong style='color:#fff'>focused time / total time</strong><br><br>Total time includes all pauses and gaps.";
  } else if (type === 'sidelined') {
    title.textContent = "Sidelined Time";
    body.innerHTML = "Tracks time where the session was running, but you were not working on a task (e.g., pauses or switching).";
  }
  toggleSheet();
}

function closeConfirm() { $('confirmEndOverlay').style.display = 'none'; }


$('endSessionBtn').onclick = () => {
  if (activePulse && !activePulse.answered) return;
  $('confirmEndOverlay').style.display = 'flex';
};
$('confirmEndBtn').onclick = () => { closeConfirm(); endSession(); };

function getElapsedTime() {
  if (!sessionStartTime) return 0;
  const now = Date.now();
  const activePause = lastPauseStart ? (now - lastPauseStart) : 0;
  return Math.max(0, now - sessionStartTime - pausedDuration - activePause);
}

function getCurrentTaskSpentSeconds() {
  if (current === null || !tasks[current]) return 0;
  const baseSeconds = tasks[current].spent || 0;
  if (!taskRunning || paused || !taskRunStartTime) return baseSeconds;
  return baseSeconds + Math.floor((Date.now() - taskRunStartTime) / 1000);
}

function formatDurationMs(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function commitCurrentTaskRun(atTime = Date.now()) {
  if (current === null || !tasks[current] || !taskRunStartTime) return;
  const deltaSeconds = Math.floor((atTime - taskRunStartTime) / 1000);
  if (deltaSeconds > 0) {
    tasks[current].spent += deltaSeconds;
  }
  taskRunStartTime = null;
}

function updateUIFromTimestamp() {
  totalFocusedSeconds = Math.floor(getElapsedTime() / 1000);
  if (current !== null && tasks[current]) {
    const spentSeconds = getCurrentTaskSpentSeconds();
    const remainingSeconds = Math.max(0, tasks[current].est - spentSeconds);
    $('countdown').textContent = formatDurationMs(remainingSeconds * 1000);
    $('stopwatch').textContent = formatDurationMs(spentSeconds * 1000);
  } else {
    $('countdown').textContent = '00:00:00';
    $('stopwatch').textContent = '00:00:00';
  }

  $('focusStopwatchMain').textContent = focusStopwatchText();
  $('focusRemainingSub').textContent = `remaining ${focusRemainingText()}`;
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    updateUIFromTimestamp();
  }
});

function startTaskRun() {
  if (current === null || !tasks[current]) return;
  if (!paused) return;
  const now = Date.now();
  sessionActive = true;
  taskRunning = true;
  paused = false;
  $('stateText').textContent = 'Running';
  if (!sessionStartTimestamp) sessionStartTimestamp = now;
  if (!sessionStartTime) sessionStartTime = now;
  if (lastPauseStart) {
    pausedDuration += (now - lastPauseStart);
    lastPauseStart = null;
  }
  taskRunStartTime = now;

  if (!tasks[current].log.length) {
    tasks[current].log.push({ type: 'START', time: now });
  } else {
    tasks[current].log.push({ type: 'RESUME', time: now });
  }
  if (tick) clearInterval(tick);
  tick = setInterval(updateUIFromTimestamp, 1000);
  updateUIFromTimestamp();
  startPulseScheduler();
  if (tasks[current].pauseStartedAt) {
    tasks[current].pauses += Math.floor((now - tasks[current].pauseStartedAt) / 1000);
    tasks[current].pauseStartedAt = null;
  }
  render();
}

function pauseTaskRun() {
  if (current === null || paused) return;
  const now = Date.now();
  taskRunning = false;
  paused = true;
  if (tick) {
    clearInterval(tick);
    tick = null;
  }
  commitCurrentTaskRun(now);
  lastPauseStart = now;
  $('stateText').textContent = 'Paused';
  tasks[current].log.push({ type: 'PAUSE', time: now });
  tasks[current].pauseStartedAt = now;
  clearPulseForTransition();
  updateUIFromTimestamp();
  render();
}

const lockSwipe = {
  active: false,
  pointerId: null,
  startX: 0,
  startLeft: 0
};

function getLockParts() {
  const wrap = $('focusLockSwitch');
  if (!wrap) return null;
  const track = wrap.querySelector('.focus-lock-track');
  const knob = wrap.querySelector('.focus-lock-knob');
  const input = $('focusLockToggle');
  if (!track || !knob || !input) return null;
  const min = 8;
  const max = track.clientWidth - knob.offsetWidth - 8;
  return { wrap, track, knob, input, min, max };
}

function onLockPointerDown(e) {
  const parts = getLockParts();
  if (!parts) return;
  if (!e.target.closest('.focus-lock-track')) return;
  lockSwipe.active = true;
  lockSwipe.pointerId = e.pointerId;
  lockSwipe.startX = e.clientX;
  lockSwipe.startLeft = parseFloat(getComputedStyle(parts.knob).left) || (parts.input.checked ? parts.max : parts.min);
  parts.knob.style.transition = 'none';
  parts.wrap.setPointerCapture(e.pointerId);
  e.preventDefault();
}

function onLockPointerMove(e) {
  if (!lockSwipe.active || e.pointerId !== lockSwipe.pointerId) return;
  const parts = getLockParts();
  if (!parts) return;
  const dx = e.clientX - lockSwipe.startX;
  const left = Math.max(parts.min, Math.min(parts.max, lockSwipe.startLeft + dx));
  parts.knob.style.left = `${left}px`;
  e.preventDefault();
}

function onLockPointerEnd(e) {
  if (!lockSwipe.active || e.pointerId !== lockSwipe.pointerId) return;
  const parts = getLockParts();
  lockSwipe.active = false;
  lockSwipe.pointerId = null;
  if (!parts) return;
  parts.wrap.releasePointerCapture(e.pointerId);
  parts.knob.style.transition = '';

  const dx = e.clientX - lockSwipe.startX;
  const swipeThreshold = Math.max(24, (parts.max - parts.min) * 0.18);
  const committed = Math.abs(dx) >= swipeThreshold;
  const wantsLocked = committed ? dx > 0 : parts.input.checked;
  parts.knob.style.left = '';

  if (wantsLocked && paused) {
    startTaskRun();
    return;
  }
  if (!wantsLocked && !paused) {
    pauseTaskRun();
    return;
  }
  render();
}

$('focusLockSwitch')?.addEventListener('pointerdown', onLockPointerDown);
document.addEventListener('pointermove', onLockPointerMove, { passive: false });
document.addEventListener('pointerup', onLockPointerEnd);
document.addEventListener('pointercancel', onLockPointerEnd);

$('focusCompleteBtn').onclick = () => {
  completeTaskWithFocusAnimation();
};

$('focusManageBtn').onclick = () => {
  if (taskRunning) {
    setScreen('focus');
  } else {
    setScreen('manage');
  }
  render();
};


/// FIRE PULSE FUNCTION ///

function firePulseNotification() {
  if (!("Notification" in window)) return;
  if (!("serviceWorker" in navigator)) return;
  if (Notification.permission === "granted") {
    navigator.serviceWorker.getRegistration().then(reg => {
      if (reg) {
        reg.showNotification("Pulse Check", {
          body: "Tap to confirm you're focused.",
          icon: "icon.png",
          badge: "icon.png"
        });
      }
    });
  }
}

function firePulse(task) {
  const now = Date.now();

  if (!sessionActive || !taskRunning || paused) return;
  if (isOverlayVisible('confirmEndOverlay') || isOverlayVisible('taskTimelineOverlay') || isOverlayVisible('resultsOverlay')) return;
  if (activePulse && activePulse.answered) {
    if (activePulse.timeout) { clearTimeout(activePulse.timeout); activePulse.timeout = null; }
    if (activePulse.colorTimer) { clearInterval(activePulse.colorTimer); activePulse.colorTimer = null; }
    activePulse = null;
  }
  if (activePulse && !activePulse.answered) {
    return; // don't stack pulses
  }

  const taskIndex = tasks.indexOf(task);
  if (taskIndex === -1) return;

  const pulseEntry = {
    task: task.text,
    taskIndex,
    time: now,
    answered: false
    
  };
  activePulse = pulseEntry;


  pulseLog.push(pulseEntry);

  task.log.push({
    type: 'PULSE',
    time: now,
    answered: false
  });
  pulseEntry.logIndex = task.log.length - 1;

  showPulsePopup(pulseEntry);
  firePulseNotification();

  lastPulseAt = now;

  pulseEntry.timeout = setTimeout(() => {
  if (!pulseEntry.answered) {
    failPulse(pulseEntry);
    }
  }, 60 * 1000);

}

/// SHOW PULSE POPUP FUNCTION ///

function showPulsePopup(pulseEntry) {
  const popup = $('pulsePopup');
  const card = $('pulseTapCard');
  const fillLayer = $('pulseFillLayer');

  popup.style.display = 'flex';
  if (fillLayer) {
    fillLayer.classList.remove('active');
    void fillLayer.offsetWidth;
    fillLayer.classList.add('active');
  }

  const pulseStart = pulseEntry.time;

  // initial color
  updatePulseColor(pulseStart);

  // update color every second
  pulseEntry.colorTimer = setInterval(() => {
    updatePulseColor(pulseStart);
  }, 1000);

  card.onclick = () => {
    clearInterval(pulseEntry.colorTimer);
    answerPulse(pulseEntry);
  };
}


/// PULSE COLOR FUNCTION ///

function updatePulseColor(startTime) {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const card = $('pulseTapCard');

  card.classList.remove('pulse-green', 'pulse-yellow', 'pulse-orange', 'pulse-red');

  if (elapsed < 10) {
    card.classList.add('pulse-green');
  } else if (elapsed < 30) {
    card.classList.add('pulse-yellow');
  } else if (elapsed < 45) {
    card.classList.add('pulse-orange');
  } else {
    card.classList.add('pulse-red');
  }
}


/// ANSWER PULSE FUNCTION ///

function answerPulse(pulseEntry) {
  pulseEntry.answered = true;
  if (pulseEntry.timeout) { clearTimeout(pulseEntry.timeout); pulseEntry.timeout = null; }
  if (pulseEntry.colorTimer) { clearInterval(pulseEntry.colorTimer); pulseEntry.colorTimer = null; }
  activePulse = null;

  const task = tasks[pulseEntry.taskIndex];
  if (task && task.log[pulseEntry.logIndex] && task.log[pulseEntry.logIndex].type === 'PULSE') {
    task.log[pulseEntry.logIndex].answered = true;
  }

  $('pulsePopup').style.display = 'none';
  $('pulseFillLayer')?.classList.remove('active');
  $('app')?.classList.remove('blurred');
  startPulseScheduler();
}

/// FAIL PULSE FUNCTION ///

function failPulse(pulseEntry) {
  if (pulseEntry.answered) return;
  pulseEntry.answered = false;
  if (pulseEntry.timeout) { clearTimeout(pulseEntry.timeout); pulseEntry.timeout = null; }
  if (pulseEntry.colorTimer) { clearInterval(pulseEntry.colorTimer); pulseEntry.colorTimer = null; }
  activePulse = null;

  const task = tasks[pulseEntry.taskIndex];
  if (!task) return;

  // mark pulse as failed in task log
  if (task.log[pulseEntry.logIndex] && task.log[pulseEntry.logIndex].type === 'PULSE') {
    task.log[pulseEntry.logIndex].failed = true;
  }

  // add 60s sidelined time
  task.pauses += 60;

  // close popup + unblur if visible
  $('pulsePopup').style.display = 'none';
  $('pulseFillLayer')?.classList.remove('active');
  $('app')?.classList.remove('blurred');
  startPulseScheduler();
}

function focusStopwatchText() {
  if (current === null || !tasks[current]) return '00:00:00';
  return formatDurationMs(getCurrentTaskSpentSeconds() * 1000);
}

function focusRemainingText() {
  if (current === null || !tasks[current]) return '00:00:00';
  return formatDurationMs(Math.max(0, tasks[current].est - getCurrentTaskSpentSeconds()) * 1000);
}

function renderFocusStack() {
  const stack = $('focusStack');
  stack.innerHTML = '';

  if (tasks.length === 0 || current === null || !tasks[current]) {
    const empty = document.createElement('div');
    empty.className = 'focus-item focus-item-current';
    empty.innerHTML = `<div class="focus-current-task">No Active Task</div>`;
    stack.appendChild(empty);
    return;
  }

  const startPrev = Math.max(0, current - 2);
  for (let i = startPrev; i < current; i++) {
    const row = document.createElement('div');
    row.className = 'focus-item focus-item-prev';
    row.textContent = tasks[i].text;
    stack.appendChild(row);
  }

  const currentRow = document.createElement('div');
  currentRow.className = 'focus-item focus-item-current';
  currentRow.dataset.taskIndex = String(current);
  currentRow.innerHTML = `<div class="focus-current-task">${tasks[current].text}</div>`;
  stack.appendChild(currentRow);

  const endNext = Math.min(tasks.length - 1, current + 2);
  for (let i = current + 1; i <= endNext; i++) {
    const row = document.createElement('div');
    row.className = 'focus-item focus-item-next';
    row.textContent = tasks[i].text;
    stack.appendChild(row);
  }
}

function renderFocusActions() {
  $('focusLockToggle').checked = taskRunning === true;
  $('focusLockToggle').disabled = current === null;
  $('focusCompleteBtn').disabled = current === null || completionInFlight;

  const manageBtn = $('focusManageBtn');
  if (!manageBtn) return;
  const visible = paused === true;
  manageBtn.classList.toggle('is-visible', visible);
  manageBtn.classList.toggle('is-hidden', !visible);
}

function completeTaskFlow() {
  if (current === null) return;

  if (!paused) {
    const now = Date.now();
    taskRunning = false;
    paused = true;
    if (tick) {
      clearInterval(tick);
      tick = null;
    }
    commitCurrentTaskRun(now);
    lastPauseStart = now;
    $('stateText').textContent = 'Paused';
  }

  clearPulseForTransition();
  const activeTask = tasks[current];
  if (completionPendingEndEntry && completionPendingEndTaskIndex === current) {
    const endIdx = activeTask.log.indexOf(completionPendingEndEntry);
    if (endIdx !== -1) {
      delete activeTask.log[endIdx].pendingComplete;
    } else {
      activeTask.log.push({ type: 'END', time: Date.now() });
    }
  } else {
    activeTask.log.push({ type: 'END', time: Date.now() });
  }
  completionPendingEndEntry = null;
  completionPendingEndTaskIndex = null;
  tasks[current].done = true;

  resetPulseScheduler();

  if (tasks.every(t => t.done)) {
    pendingSessionEnd = true;
  }

  const next = tasks.findIndex(t => !t.done);
  current = next !== -1 ? next : null;
  completionInFlight = false;
  $('focusCompleteWrap')?.classList.remove('focus-complete-firing');

  render();

  if (pendingSessionEnd) {
    pendingSessionEnd = false;
    endSession();
  }
}

function animateStackCompletionAndCommit() {
  const stack = $('focusStack');
  const currentItem = stack ? stack.querySelector('.focus-item-current') : null;
  const nextItems = stack ? Array.from(stack.querySelectorAll('.focus-item-next')) : [];
  const nextItem = nextItems.length ? nextItems[0] : null;
  const trailingNextItems = nextItems.slice(1);
  const prevItems = stack ? stack.querySelectorAll('.focus-item-prev') : [];

  if (!stack || !currentItem) {
    completeTaskFlow();
    return;
  }

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    stack.classList.remove('completing');
    currentItem.classList.remove('focus-item-complete-out');
    if (nextItem) nextItem.classList.remove('focus-item-promote');
    prevItems.forEach(el => el.classList.remove('focus-item-shift-up'));
    trailingNextItems.forEach(el => el.classList.remove('focus-item-next-shift'));
    completeTaskFlow();
  };

  const onTransitionEnd = (e) => {
    if (e.target !== currentItem || e.propertyName !== 'transform') return;
    finish();
  };

  currentItem.addEventListener('transitionend', onTransitionEnd, { once: true });
  stack.classList.add('completing');
  currentItem.classList.add('focus-item-complete-out');
  if (nextItem) nextItem.classList.add('focus-item-promote');
  prevItems.forEach(el => el.classList.add('focus-item-shift-up'));
  trailingNextItems.forEach(el => el.classList.add('focus-item-next-shift'));
  setTimeout(finish, 360);
}

function completeTaskWithFocusAnimation() {
  if (current === null) return;
  if (completionInFlight) return;
  if (activePulse && !activePulse.answered) return;
  if (!paused) {
    pauseTaskRun();
  }
  const task = tasks[current];
  completionPendingEndEntry = { type: 'END', time: Date.now(), pendingComplete: true };
  completionPendingEndTaskIndex = current;
  task.log.push(completionPendingEndEntry);
  completionInFlight = true;
  timelineMode = 'complete';
  timelineTaskIndex = current;
  openTaskTimeline(current, 'complete');
}


/// RENDER FUNCTION ///

function render() {
  syncScreenRoute();
  clearDragVisuals();
  const list = $('taskList'); list.innerHTML = '';
  tasks.forEach((t, i) => {
    const d = document.createElement('div');
    d.className = 'task' + (i === current ? ' selected' : '') + (t.done ? ' done' : '');
    d.onclick = () => {
      if (suppressTaskClick) {
        suppressTaskClick = false;
        return;
      }
      if (!t.done && paused) { clearPulseForTransition(); current = i; render(); }
    };
    
    const content = document.createElement('div');
    content.className = 'task-content';
    content.innerHTML = `<b>${t.text}</b>${t.mode ? `<br><small style="font-size:11px; color:var(--muted); opacity:0.75">${t.mode}</small>` : ''}`;
    d.appendChild(content);

    if (!t.done && paused) {
      const eb = document.createElement('button');
      eb.innerHTML = '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16v4Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path><path d="m12 6 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
      eb.style.cssText = "background:transparent; border:none; display:flex; align-items:center; justify-content:center;";
      eb.onclick = (e) => { e.stopPropagation(); openEdit(i); };
      d.appendChild(eb);
    }

    if (paused) {
      d.draggable = true;
      d.addEventListener('dragstart', (e) => onTaskDragStart(e, i, d));
      d.addEventListener('dragover', (e) => onTaskDragOver(e, d));
      d.addEventListener('drop', (e) => onTaskDrop(e, d));
      d.addEventListener('dragend', onTaskDragEnd);
      d.addEventListener('pointerdown', (e) => onTaskPointerDown(e, i, d));
    } else {
      d.draggable = false;
    }

    list.appendChild(d);
  });
  updateUIFromTimestamp();
  $('addWrapper').style.display = (paused || current === null) ? 'flex' : 'none';
  $('timerGrid').style.display = (current !== null) ? 'block' : 'none';
  $('endSessionBtn').disabled = !sessionStartTimestamp;
  $('endSessionBtn').style.opacity = sessionStartTimestamp ? '1' : '0.45';
  $('endSessionBtn').style.pointerEvents = sessionStartTimestamp ? 'auto' : 'none';
  $('actionButtons').style.display = 'flex';
  $('startBtn').textContent = 'enter session';
  $('startBtn').disabled = current === null;
  $('startBtn').style.opacity = current === null ? '0.45' : '1';
  $('startBtn').style.pointerEvents = current === null ? 'none' : 'auto';
  renderFocusStack();
  renderFocusActions();
}

/// OPEN TASK TIMELINE FUNCTION ///

function openTaskTimeline(index, mode = 'view') {
  if (activePulse && !activePulse.answered) {
    completionInFlight = false;
    $('focusCompleteWrap')?.classList.remove('focus-complete-firing');
    return;
  }
  timelineMode = mode;
  timelineTaskIndex = index;
  const t = tasks[index];
  const tbody = $('taskTimelineTable').querySelector('tbody');
  tbody.innerHTML = '';
  const confirmBtn = $('confirmTaskTimelineBtn');
  const backBtn = $('backTaskTimelineBtn');
  confirmBtn.textContent = mode === 'complete' ? 'Confirm' : 'Close';
  backBtn.style.display = mode === 'complete' ? 'block' : 'none';

  t.log.forEach((e, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${e.type}</td>
      <td>${new Date(e.time).toLocaleTimeString()}</td>

      <td>${e.type === 'PULSE'? `<input type="checkbox" ${e.answered ? 'checked' : ''} onchange="this.checked ? (tasks[${index}].log[${i}].answered = true) : (tasks[${index}].log[${i}].answered = false)">`: '-'}</td>
    `;

    tbody.appendChild(tr);
  });

  $('taskTimelineOverlay').style.display = 'flex';

  backBtn.onclick = () => {
    $('taskTimelineOverlay').style.display = 'none';
    if (timelineMode === 'complete' && completionPendingEndEntry && completionPendingEndTaskIndex !== null) {
      const backTask = tasks[completionPendingEndTaskIndex];
      if (backTask) {
        const pendingIdx = backTask.log.indexOf(completionPendingEndEntry);
        if (pendingIdx !== -1) {
          backTask.log.splice(pendingIdx, 1);
        }
      }
      completionPendingEndEntry = null;
      completionPendingEndTaskIndex = null;
    }
    completionInFlight = false;
    $('focusCompleteWrap')?.classList.remove('focus-complete-firing');
    renderFocusActions();
  };

  confirmBtn.onclick = () => {
    $('taskTimelineOverlay').style.display = 'none';

    if (timelineMode === 'complete') {
      $('focusCompleteWrap')?.classList.add('focus-complete-firing');
      animateStackCompletionAndCommit();
      return;
    }

    render();
  };
}

$('openAddModalBtn').onclick = () => {
  editingIndex = null;
  $('modalTitle').innerHTML = modalAddIcon;
  $('modalTaskName').value = ""; 
  smartTypedDigits = '';
  setSmartMaskFromDigits();
  $('workModeSelect').value = '';
  $('pulseRange').value = '0';
  setPulseRangeLabel();
  $('editorActionsRow').classList.remove('edit-mode');
  $('editorActionsRow').classList.add('add-mode');
  $('deleteTaskBtn').classList.remove('is-enabled');
  $('deleteTaskBtn').classList.add('is-disabled');
  $('deleteTaskBtn').disabled = true;
  $('taskEditorOverlay').style.display = 'flex';
};

/// OPEN EDIT FUNCTION ///

function openEdit(index) {
  editingIndex = index;
  const t = tasks[index];
  $('modalTitle').innerHTML = modalEditIcon;
  $('modalTaskName').value = t.text;
  const h = Math.floor(t.est/3600), m = Math.floor((t.est%3600)/60), s = t.est%60;
  smartTypedDigits = `${String(h).padStart(2,'0')}${String(m).padStart(2,'0')}${String(s).padStart(2,'0')}`.slice(-6);
  setSmartMaskFromDigits();
  $('workModeSelect').value = t.mode || '';
  const pulseVal = (t.pulse || 0) < 5 ? 0 : Math.max(5, Math.min(15, t.pulse || 0));
  $('pulseRange').value = String(pulseVal);
  setPulseRangeLabel();
  $('editorActionsRow').classList.remove('add-mode');
  $('editorActionsRow').classList.add('edit-mode');
  $('deleteTaskBtn').classList.remove('is-disabled');
  $('deleteTaskBtn').classList.add('is-enabled');
  $('deleteTaskBtn').disabled = false;
  $('taskEditorOverlay').style.display = 'flex';
}

/// DELETE TASK FUNCTION ///

$('deleteTaskBtn').onclick = () => {
  if (editingIndex !== null) {
    tasks.splice(editingIndex, 1);
    if (current === null && tasks.length) {
      current = tasks.findIndex(t => !t.done);
    }
    $('taskEditorOverlay').style.display = 'none';
    render();
  }
};

/// SAVE TASK FUNCTION ///

$('saveTaskBtn').onclick = () => {
  const name = $('modalTaskName').value.trim(), timeStr = $('smartTimeInput').value;
  if (!name || timeToSeconds(timeStr) <= 0) return;
  const mode = $('workModeSelect').value;
  const pulseRaw = parseInt($('pulseRange').value, 10) || 0;
  const pulse = pulseRaw < 5 ? 0 : Math.max(5, Math.min(15, pulseRaw));
  
  if (editingIndex === null) {
    tasks.push({ text: name, est: timeToSeconds(timeStr), spent: 0, done: false, log: [], pauses: 0,pauseStartedAt: null, mode, pulse });
  } else {
    tasks[editingIndex].text = name; 
    tasks[editingIndex].est = timeToSeconds(timeStr);
    tasks[editingIndex].mode = mode;
    tasks[editingIndex].pulse = pulse;
  }
  $('taskEditorOverlay').style.display = 'none'; 
  render();
};

$('cancelEditor').onclick = () => { $('taskEditorOverlay').style.display = 'none'; };

/// START BUTTON FUNCTION ///

$('startBtn').onclick = () => {
  if (current === null) return;
  sessionActive = true;
  taskRunning = false;
  paused = true;
  if (tick) {
    clearInterval(tick);
    tick = null;
  }
  resetPulseScheduler();
  $('stateText').textContent = 'Idle';
  updateUIFromTimestamp();
  setScreen('focus');
  render();
};

/// COMPLETE BUTTON FUNCTION ///

if ($('completeBtn')) {
  $('completeBtn').onclick = () => {
    completeTaskWithFocusAnimation();
  };
}

/// END SESSION FUNCTION ///

function endSession() {
  const endAt = Date.now();
  completionInFlight = false;
  completionPendingEndEntry = null;
  completionPendingEndTaskIndex = null;
  $('focusCompleteWrap')?.classList.remove('focus-complete-firing');
  clearPulseForTransition();
  if (tick) {
    clearInterval(tick);
    tick = null;
  }
  if (taskRunning && !paused) {
    commitCurrentTaskRun(endAt);
  }
  paused = true;
  taskRunning = false;
  sessionActive = false;
  sessionEndTimestamp = endAt;
  totalFocusedSeconds = Math.floor(getElapsedTime() / 1000);
  if (!sessionStartTimestamp) sessionStartTimestamp = sessionEndTimestamp;
  const total = Math.floor((sessionEndTimestamp - sessionStartTimestamp) / 1000);
  const ratio = total > 0 ? Math.round((totalFocusedSeconds / total) * 100) : 0;
  $('resTotal').textContent = fmt(total);
  $('resFocused').textContent = fmt(totalFocusedSeconds);
  $('resPaused').textContent = fmt(Math.max(0, total - totalFocusedSeconds));
  $('resRatio').textContent = ratio + '%';
  const tbody = $('resBreakdown').querySelector('tbody');
  tbody.innerHTML = '';

  tasks.forEach((t, i) => {
    const total = t.spent + (t.pauses || 0);
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.innerHTML = `
     <td>${t.text}</td>
      <td>${t.mode || '-'}</td>
      <td>${fmt(t.pauses || 0)}</td>
      <td>${fmt(t.spent)}</td>
      <td>${fmt(total)}</td>
    `;
    tr.onclick = () => openTaskTimeline(i);
    tbody.appendChild(tr);
  });
  

  $('resultsOverlay').style.display = 'flex';
}

$('closeStatsBtn').onclick = () => {
  tasks = [];
  current = null;
  sessionStartTimestamp = null;
  sessionStartTime = null;
  pausedDuration = 0;
  lastPauseStart = null;
  taskRunStartTime = null;
  totalFocusedSeconds = 0;
  sessionActive = false;
  taskRunning = false;
  completionInFlight = false;
  completionPendingEndEntry = null;
  completionPendingEndTaskIndex = null;
  $('focusCompleteWrap')?.classList.remove('focus-complete-firing');
  $('resultsOverlay').style.display = 'none';
  render();
};

render();
 

 
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js")
      .then(reg => {
        console.log("SW registered");
        if ("Notification" in window && Notification.permission !== "granted") {
          console.log("Notification perms requested")
          Notification.requestPermission();
        }
        return reg;
      })
      .catch(err => console.log("SW failed", err));
  });
}
 
