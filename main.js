import { createClient } from '@supabase/supabase-js'

// --- CONFIGURATION ---
const supabase = createClient(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_ANON_KEY
)

const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.profile';

// --- GLOBAL STATE ---
let db = {}; // Will now store: { date_key: { notes: [{id, content, position}], event_name, tags } }
let activeKey = null; 
let pendingNoteContent = ''; 
let showRealDates = true;  
let showCycleDays = false; 

// UI State
// Levels: 0=Year, 1=Quarter, 2=Week (formerly 3), 3=Day (formerly 4)
// Removed the "Single Cycle" (Month-like) view as requested.
const MAX_ZOOM_LEVEL = 3;
let viewLevel = 0; 
let focusRefs = { q: null }; // Only need Quarter focus for Level 1
let isZooming = false;
let isSyncing = false;
let gapiReady = false;

// Calendar Data
let anchorDate = new Date(localStorage.getItem('calendarAnchorDate') || '2025-12-29');

const timespans = [
    {name: "Q1C1", len: 28}, {name: "Q1C2", len: 28}, {name: "Q1C3", len: 28}, {name: "Reset 1", len: 7},
    {name: "Q2C1", len: 28}, {name: "Q2C2", len: 28}, {name: "Q2C3", len: 28}, {name: "Reset 2", len: 7},
    {name: "Q3C1", len: 28}, {name: "Q3C2", len: 28}, {name: "Q3C3", len: 28}, {name: "Reset 3", len: 7},
    {name: "Q4C1", len: 28}, {name: "Q4C2", len: 28}, {name: "Q4C3", len: 28}, {name: "Reset 4", len: 7}
];


// --- INIT ---
async function init() {
    setupEventListeners();
    
    // Unconditional data load (fixes "notes disappear")
    await loadNotesFromSupabase();
    
    // Force migration check
    await migrateOldNotes();
    
    // Restore session & Background Sync
    restoreUserSession();

    // Initial UI
    render();
    updateZoomUI();
    updateNoteList();
}

function setupEventListeners() {
    const main = document.getElementById('main');
    if (main) main.addEventListener('wheel', handleWheel, { passive: false });
    
    bindClick('zoomOutBtn', zoomOut);
    bindClick('saveNoteBtn', saveData);
    bindClick('saveFromFocusBtn', saveFromFocus);
    bindClick('loginBtn', () => syncWithGoogle(false));
    bindClick('logoutBtn', logout);

    const tReal = document.getElementById('toggleRealDate');
    if (tReal) tReal.onchange = (e) => { showRealDates = e.target.checked; render(); };
    
    const tCycle = document.getElementById('toggleCycleNum');
    if (tCycle) tCycle.onchange = (e) => { showCycleDays = e.target.checked; render(); };
    
    const noteArea = document.getElementById('noteArea');
    if (noteArea) {
        noteArea.addEventListener('input', () => { pendingNoteContent = noteArea.value; });
        // Add Ctrl+Enter to save
        noteArea.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                saveData();
            }
        });
    }

    const anchorInput = document.getElementById('anchorDateInput');
    if (anchorInput) {
        anchorInput.value = anchorDate.toISOString().split('T')[0];
        anchorInput.onchange = (e) => {
            const d = new Date(e.target.value);
            if (!isNaN(d.getTime())) {
                anchorDate = d;
                localStorage.setItem('calendarAnchorDate', d.toISOString());
                render();
            }
        };
    }

    const search = document.getElementById('tagSearch');
    if (search) search.addEventListener('input', (e) => renderNoteList(e.target.value));
}

function bindClick(id, fn) {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
}

// --- DATA & AUTH ---

async function loadNotesFromSupabase() {
    try {
        // Load individual notes
        const { data: noteItems, error: notesError } = await supabase
            .from('cyclic_note_items')
            .select('*')
            .order('position', { ascending: true });
        
        if (notesError) throw notesError;

        // Structure data by date_key
        db = {};
        
        // Add notes from new table
        if (noteItems) {
            noteItems.forEach(item => {
                if (!db[item.date_key]) {
                    db[item.date_key] = { notes: [], event_name: '', tags: [] };
                }
                db[item.date_key].notes.push({
                    id: item.id,
                    content: item.content,
                    position: item.position
                });
            });
        }

    } catch (err) {
        console.error("Failed to load notes:", err);
    }
}

// Migration function to convert old notes to new format
async function migrateOldNotes() {
    // Force migration for debugging
    console.log("Forcing migration check...");
    
    try {
        console.log("Starting migration...");
        
        // Fetch old notes
        const { data: oldNotes, error } = await supabase
            .from('cyclic_notes')
            .select('date_key, content');
        
        if (error) {
            console.error("Error fetching old notes:", error);
            return;
        }
        
        console.log("Old notes found:", oldNotes);
        
        if (!oldNotes || oldNotes.length === 0) {
            console.log("No old notes to migrate");
            return;
        }
        
        // Check if new table already has data
        const { data: existingNotes } = await supabase
            .from('cyclic_note_items')
            .select('id')
            .limit(1);
        
        console.log("Existing notes in new table:", existingNotes);
        
        if (existingNotes && existingNotes.length > 0) {
            console.log("New notes already exist, skipping migration");
            return;
        }
        
        // Migrate each old note
        let migratedCount = 0;
        for (const oldNote of oldNotes) {
            if (!oldNote.content || oldNote.content.trim() === '') continue;
            
            // Split content by newlines (each line becomes a note)
            const lines = oldNote.content.split('\n').filter(line => line.trim() !== '');
            
            console.log(`Migrating note for ${oldNote.date_key}: ${lines.length} lines`);
            
            for (let i = 0; i < lines.length; i++) {
                const { error: insertError } = await supabase
                    .from('cyclic_note_items')
                    .insert({
                        date_key: oldNote.date_key,
                        content: lines[i].trim(),
                        position: i
                    });
                
                if (insertError) {
                    console.error("Error migrating note:", insertError);
                } else {
                    migratedCount++;
                }
            }
        }
        
        console.log(`Migration complete! Migrated ${migratedCount} notes.`);
        
        // Reload data
        await loadNotesFromSupabase();
        render();
        alert(`Migration complete! Migrated ${migratedCount} notes.`);
        
    } catch (err) {
        console.error("Migration failed:", err);
    }
}

function restoreUserSession() {
    const token = localStorage.getItem('googleAccessToken');
    const name = localStorage.getItem('userName');
    const avatar = localStorage.getItem('userAvatar');

    if (token) {
        updateAuthUI(true, name, avatar);
        syncWithGoogle(true); // Background sync to keep fresh
    } else {
        updateAuthUI(false);
    }
}

function updateAuthUI(isLoggedIn, name, avatar) {
    const login = document.getElementById('loginBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const uName = document.getElementById('userName');
    const uAvatar = document.getElementById('avatarCircle');

    if (isLoggedIn) {
        if (login) login.style.display = 'none';
        if (logoutBtn) logoutBtn.style.display = 'block';
        if (uName) uName.textContent = name || 'User';
        if (uAvatar && avatar) {
            uAvatar.innerHTML = `<img src="${avatar}" alt="${name}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">`;
        }
    } else {
        if (login) login.style.display = 'block';
        if (logoutBtn) logoutBtn.style.display = 'none';
        if (uName) uName.textContent = 'Not Signed In';
        if (uAvatar) uAvatar.innerHTML = '';
    }
}

function logout() {
    localStorage.removeItem('googleAccessToken');
    localStorage.removeItem('userName');
    localStorage.removeItem('userAvatar');
    updateAuthUI(false);
    console.log("Logged out.");
}

// --- ZOOM LOGIC (Refactored) ---
// 0: Year, 1: Quarter, 2: Week, 3: Day

let zoomTarget = null;

function updateZoomUI() {
    const main = document.getElementById('main');
    if (main) main.className = `view-level-${viewLevel}`;
    const btn = document.getElementById('zoomOutBtn');
    if (btn) btn.style.display = viewLevel > 0 ? 'block' : 'none';
}

function zoomOut() {
    if (viewLevel > 0) {
        viewLevel--;
        render();
        updateZoomUI();
    }
}

function handleWheel(e) {
    e.preventDefault();
    if (isZooming) return;

    if (e.deltaY < 0) { // Zoom In
        if (viewLevel < MAX_ZOOM_LEVEL) {
            const hDay = e.target.closest('.day');
            const hQuarter = e.target.closest('.quarter-group');
            const hCycle = e.target.closest('.month-wrapper');
            
            let next = viewLevel;
            zoomTarget = null;

            if (viewLevel === 0 && (hQuarter || hCycle)) {
                // Year -> Quarter
                const quarterEl = hQuarter || hCycle.closest('.quarter-group');
                const all = [...document.querySelectorAll('.quarter-group')];
                focusRefs.q = all.indexOf(quarterEl);
                if (hCycle && hCycle.dataset.cycleIndex) {
                    zoomTarget = { type: 'cycle', cycleIndex: parseInt(hCycle.dataset.cycleIndex, 10) };
                } else {
                    zoomTarget = { type: 'quarter', qIndex: focusRefs.q };
                }
                next = 1;
            } else if (viewLevel === 1 && hDay) {
                // Quarter -> Week (Skipping Cycle)
                savePendingNote();
                activeKey = hDay.dataset.key;
                zoomTarget = { type: 'week', key: activeKey };
                next = 2; // Jump to Week
            } else if (viewLevel === 2 && hDay) {
                // Week -> Day
                savePendingNote();
                activeKey = hDay.dataset.key;
                zoomTarget = { type: 'day', key: activeKey };
                next = 3;
            }

            if (next !== viewLevel) {
                viewLevel = next;
                executeZoom();
            }
        }
    } else { // Zoom Out
        if (viewLevel > 0) {
            viewLevel--;
            executeZoom();
        }
    }
}

function executeZoom() {
    isZooming = true;
    render();
    updateZoomUI();
    
    // After render completes, smooth scroll to center the zoomed element
    setTimeout(() => {
        scrollToZoomTarget(zoomTarget);
        zoomTarget = null;
        setTimeout(() => { isZooming = false; }, 600); // Wait for animation
    }, 50);
}

function scrollToZoomTarget(target) {
    if (!target) return;

    let element = null;
    if (target.type === 'quarter') {
        const quarters = document.querySelectorAll('.quarter-group');
        element = quarters[target.qIndex] || null;
    } else if (target.type === 'cycle') {
        element = document.querySelector(`.month-wrapper[data-cycle-index="${target.cycleIndex}"]`) || null;
    } else if (target.type === 'week') {
        element = document.querySelector(`.week-day[data-key="${target.key}"]`) || document.querySelector('.week-wrapper');
    } else if (target.type === 'day') {
        element = document.getElementById('dayFocusView') || document.getElementById('calContainer');
    }

    smoothScrollToCenter(element);
}

function smoothScrollToCenter(element) {
    if (!element) return;

    const container = document.getElementById('main');
    if (!container) return;

    const rect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const header = document.getElementById('zoomHeader');
    const headerHeight = header ? header.getBoundingClientRect().height : 0;
    const style = getComputedStyle(container);
    const padTop = parseFloat(style.paddingTop) || 0;
    const padBottom = parseFloat(style.paddingBottom) || 0;

    const visibleTop = containerRect.top + headerHeight + padTop;
    const visibleHeight = Math.max(0, container.clientHeight - headerHeight - padTop - padBottom);

    const targetLeft = container.scrollLeft + (rect.left - containerRect.left) - (container.clientWidth / 2) + (rect.width / 2);
    const targetTop = container.scrollTop + (rect.top - visibleTop) - (visibleHeight / 2) + (rect.height / 2);

    const startX = container.scrollLeft;
    const startY = container.scrollTop;
    const deltaX = targetLeft - startX;
    const deltaY = targetTop - startY;
    const duration = 500;
    const startTime = performance.now();

    const maxX = Math.max(0, container.scrollWidth - container.clientWidth);
    const maxY = Math.max(0, container.scrollHeight - container.clientHeight);

    function easeOutBack(t) {
        const c1 = 1.70158;
        const c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }

    function animate(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const easeProgress = easeOutBack(progress);

        const nextX = startX + deltaX * easeProgress;
        const nextY = startY + deltaY * easeProgress;

        container.scrollLeft = Math.min(maxX, Math.max(0, nextX));
        container.scrollTop = Math.min(maxY, Math.max(0, nextY));

        if (progress < 1) {
            requestAnimationFrame(animate);
        }
    }

    requestAnimationFrame(animate);
}

// --- RENDER ENGINE ---

function render() {
    const container = document.getElementById('calContainer');
    if (!container) return;
    container.innerHTML = "";

    if (viewLevel === 3) {
        renderDayFocus();
        return;
    }
    if (viewLevel === 2) {
        renderWeekView(container);
        return;
    }
    
    renderGrid(container);
}

function renderDayFocus() {
    if (!activeKey) return;
    const [y, m, d] = activeKey.split('-').map(Number);
    const date = new Date(y, m-1, d);

    setText('dayFocusHeader', date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
    setText('dayFocusSubheader', getFormattedCyclicDate(activeKey));

    // Note: This view is for the old "add note" textarea if needed
    // The main display uses the week view which shows individual notes
}

function renderWeekView(container) {
    if (!activeKey) {
        container.innerHTML = '<div style="padding: 20px; color: red;">No activeKey set for week view</div>';
        return;
    }
    const info = getCycleInfoForKey(activeKey);
    if (!info) {
        container.innerHTML = `<div style="padding: 20px; color: red;">No cycle info for activeKey: ${activeKey}</div>`;
        return;
    }

    const start = new Date(info.cycleStart);
    start.setDate(start.getDate() + Math.floor(info.dayInCycle / 7) * 7);
    
    const wrapper = document.createElement('div');
    wrapper.className = 'week-wrapper';

    for (let i = 0; i < 7; i++) {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        const key = getKey(d);
        const dayData = db[key] || { notes: [] };
        
        const el = document.createElement('div');
        el.className = `week-day ${key === getTodayKey() ? 'is-today' : ''} ${key === activeKey ? 'active' : ''}`;
        el.dataset.key = key;

        // Header
        const header = document.createElement('div');
        header.className = 'week-day-header';
        header.innerHTML = `
            <div class="week-day-title">${d.toLocaleDateString('en-US', {weekday:'long'})}</div>
            <div class="week-day-date">${d.toLocaleDateString('en-US', {month:'short', day:'numeric'})}</div>
            <div style="font-size: 10px; color: #666;">Key: ${key}</div>
            <div style="font-size: 10px; color: #666;">Notes: ${dayData.notes ? dayData.notes.length : 0}</div>
        `;
        el.appendChild(header);

        // Notes area
        const notesArea = document.createElement('div');
        notesArea.className = 'week-day-notes';
        notesArea.dataset.dateKey = key;

        if (dayData.notes && dayData.notes.length > 0) {
            dayData.notes.forEach((note, index) => {
                const noteEl = createNoteElement(note, key, index);
                notesArea.appendChild(noteEl);
            });
        } else {
            notesArea.innerHTML = '<div class="week-note empty">No notes</div>';
        }

        el.appendChild(notesArea);

        // Add note button
        const actions = document.createElement('div');
        actions.className = 'week-day-actions';
        actions.innerHTML = `<button class="add-note-btn" data-key="${key}">+ Add Note</button>`;
        el.appendChild(actions);

        wrapper.appendChild(el);
    }
    
    container.appendChild(wrapper);
    attachWeekViewHandlers();
}

function createNoteElement(note, dateKey, index) {
    const noteEl = document.createElement('div');
    noteEl.className = 'week-note-item';
    noteEl.draggable = true;
    noteEl.dataset.noteId = note.id;
    noteEl.dataset.dateKey = dateKey;
    noteEl.dataset.position = note.position;
    
    // Extract tags from content (support dashes, underscores)
    const content = note.content || '';
    const tags = content.match(/#[\w-]+/g) || [];
    const textWithoutTags = content.replace(/#[\w-]+/g, '').trim();
    
    // Generate color for each tag
    const tagsHtml = tags.length > 0 
        ? `<div class="note-tags">${tags.map(tag => {
            const color = getTagColor(tag);
            return `<span class="tag" style="background: ${color.bg}; color: ${color.text}">${tag}</span>`;
        }).join('')}</div>`
        : '';
    
    noteEl.innerHTML = `
        <div class="note-drag-handle">⋮⋮</div>
        <div class="note-content-wrapper">
            <div class="note-content" contenteditable="true">${textWithoutTags}</div>
            ${tagsHtml}
        </div>
        <button class="note-delete-btn" data-note-id="${note.id}" data-date-key="${dateKey}">🗑️</button>
    `;
    
    return noteEl;
}

// Generate consistent color for a tag
function getTagColor(tag) {
    const colorPairs = [
        { bg: '#FFE6E6', text: '#8B0000' }, // light red bg, dark red text
        { bg: '#FFE6F0', text: '#8B004B' }, // light pink bg, dark pink text
        { bg: '#F0E6FF', text: '#4B008B' }, // light purple bg, dark purple text
        { bg: '#E6E6FF', text: '#00008B' }, // light indigo bg, dark indigo text
        { bg: '#E6F0FF', text: '#003D8B' }, // light blue bg, dark blue text
        { bg: '#E6F7FF', text: '#006B8B' }, // light sky bg, dark sky text
        { bg: '#E6FFFF', text: '#008B8B' }, // light cyan bg, dark cyan text
        { bg: '#E6FFF0', text: '#008B4B' }, // light teal bg, dark teal text
        { bg: '#E6FFE6', text: '#006400' }, // light green bg, dark green text
        { bg: '#F0FFE6', text: '#4B8B00' }, // light lime bg, dark lime text
        { bg: '#FFFFE6', text: '#8B8B00' }, // light yellow bg, dark yellow text
        { bg: '#FFF7E6', text: '#8B6B00' }, // light gold bg, dark gold text
        { bg: '#FFE6D9', text: '#8B4500' }, // light orange bg, dark orange text
        { bg: '#FFE6E0', text: '#8B2500' }, // light coral bg, dark coral text
        { bg: '#F5E6FF', text: '#6B008B' }, // light violet bg, dark violet text
        { bg: '#FFE6F7', text: '#8B0066' }, // light magenta bg, dark magenta text
        { bg: '#E6F5FF', text: '#004D8B' }, // light azure bg, dark azure text
        { bg: '#E6FFEB', text: '#00663D' }, // light mint bg, dark mint text
        { bg: '#FFF0E6', text: '#8B5A00' }, // light peach bg, dark peach text
        { bg: '#F0E6E6', text: '#663333' }, // light brown bg, dark brown text
    ];
    
    let hash = 0;
    for (let i = 0; i < tag.length; i++) {
        hash = tag.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colorPairs[Math.abs(hash) % colorPairs.length];
}

function attachWeekViewHandlers() {
    // Add note buttons
    document.querySelectorAll('.add-note-btn').forEach(btn => {
        btn.onclick = async (e) => {
            e.stopPropagation();
            const key = btn.dataset.key;
            await addNewNote(key);
        };
    });

    // Delete buttons
    document.querySelectorAll('.note-delete-btn').forEach(btn => {
        btn.onclick = async (e) => {
            e.stopPropagation();
            const noteId = btn.dataset.noteId;
            const dateKey = btn.dataset.dateKey;
            await deleteNoteItem(noteId, dateKey);
        };
    });

    // Content editing
    document.querySelectorAll('.note-content').forEach(content => {
        content.addEventListener('blur', async (e) => {
            const noteEl = e.target.closest('.week-note-item');
            const noteId = noteEl.dataset.noteId;
            const newContent = e.target.textContent.trim();
            await updateNoteContent(noteId, newContent);
        });
    });

    // Drag and drop
    const noteItems = document.querySelectorAll('.week-note-item');
    noteItems.forEach(item => {
        item.addEventListener('dragstart', handleDragStart);
        item.addEventListener('dragover', handleDragOver);
        item.addEventListener('drop', handleDrop);
        item.addEventListener('dragend', handleDragEnd);
    });
}

function renderGrid(container) {
    const weekDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const today = getTodayKey();
    let run = new Date(anchorDate);

    for (let q = 0; q < 4; q++) {
        // Level 1: Only show focused quarter
        if (viewLevel === 1 && focusRefs.q !== q) {
            timespans.slice(q*4, q*4+4).forEach(s => run.setDate(run.getDate() + s.len));
            continue;
        }

        const qDiv = document.createElement('div');
        qDiv.className = 'quarter-group';
        qDiv.dataset.qIndex = q;
        
        timespans.slice(q*4, q*4+4).forEach((s) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'month-wrapper';
            wrapper.dataset.cycleIndex = (q * 4 + sIdx).toString();
            wrapper.dataset.cycleName = s.name;
            const cls = s.name.includes('C1') ? 'bg-c1' : s.name.includes('C2') ? 'bg-c2' : s.name.includes('C3') ? 'bg-c3' : 'bg-reset';
            
            wrapper.innerHTML = `
                <div class="month-header ${cls}">${s.name}</div>
                <div class="weekday-header">${weekDays.map(d => `<div>${d}</div>`).join('')}</div>
                <div class="month-grid"></div>
            `;
            const grid = wrapper.querySelector('.month-grid');

            for (let i = 1; i <= s.len; i++) {
                const key = getKey(run);
                const data = db[key] || {};
                const dayEl = document.createElement('div');
                dayEl.className = `day ${cls} ${key === today ? 'is-today' : ''} ${key === activeKey ? 'active' : ''}`;
                dayEl.dataset.key = key;
                dayEl.onclick = (e) => handleDayClick(e, key, data); 

                const noteCount = data.notes ? data.notes.length : 0;
                const noteDots = noteCount > 0 ? '<div class="dot dot-note"></div>'.repeat(noteCount) : '';

                dayEl.innerHTML = `
                    ${showCycleDays ? `<div class="cycle-num">${i}</div>` : ''}
                    ${showRealDates ? `<div class="real-date">${run.getDate()} ${run.toLocaleDateString('en-US',{month:'short'})}</div>` : ''}
                    <div class="dot-row">
                        ${noteDots}
                        ${data.event_name ? '<div class="dot" style="background:var(--event);"></div>' : ''}
                    </div>
                `;
                grid.appendChild(dayEl);
                run.setDate(run.getDate() + 1);
            }
            qDiv.appendChild(wrapper);
        });
        container.appendChild(qDiv);
    }
}

function handleDayClick(e, key, data) {
    e.stopPropagation();
    savePendingNote();
    activeKey = key;
    updateSelectionUI(key, data);
    render();
}

// --- HELPERS ---

function getKey(d) { return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; }
function getTodayKey() { return getKey(new Date()); }
function setText(id, txt) { const el = document.getElementById(id); if(el) el.textContent = txt; }

function savePendingNote() {
    const area = document.getElementById('noteArea');
    if (area && area.value) pendingNoteContent = area.value;
}

function updateSelectionUI(key, data) {
    setText('selLabel', `${key} (${getFormattedCyclicDate(key)})`);
    const area = document.getElementById('noteArea');
    if (area) {
        // Clear textarea for adding new notes
        area.value = '';
        area.placeholder = 'Type here to add a new note...';
    }
    const evt = document.getElementById('eventInput');
    if (evt) evt.value = data.event_name || '';
    
    // Update the note list sidebar with individual notes
    updateNoteList();
}

function getFormattedCyclicDate(targetKey) {
    let run = new Date(anchorDate);
    for (let q = 0; q < 4; q++) {
        for (let sIdx = 0; sIdx < 4; sIdx++) {
            const span = timespans[q*4+sIdx];
            for (let d = 1; d <= span.len; d++) {
                if (getKey(run) === targetKey) {
                    const w = Math.ceil(d/7);
                    const dw = ((d-1)%7)+1;
                    const c = span.name.includes('Reset') ? 'R' : span.name.split('Q'+(q+1))[1];
                    return `Q${q+1}.${c}.W${w}.D${dw}`;
                }
                run.setDate(run.getDate() + 1);
            }
        }
    }
    return "";
}

function getCycleInfoForKey(targetKey) {
    let run = new Date(anchorDate);
    for (let q = 0; q < 4; q++) {
        for (let sIdx = 0; sIdx < 4; sIdx++) {
            const span = timespans[q*4 + sIdx];
            const start = new Date(run);
            for (let d = 1; d <= span.len; d++) {
                if (getKey(run) === targetKey) {
                    return { cycleIdx: q*4+sIdx, cycleName: span.name, cycleStart: start, dayInCycle: d-1 };
                }
                run.setDate(run.getDate() + 1);
            }
        }
    }
    return null;
}

// --- SYNC & CRUD ---

async function syncWithGoogle(background = false) {
    if (isSyncing) return;
    isSyncing = true;
    const statusFn = (m, c) => { if(!background) updateSyncStatus(m,c); };
    statusFn('Syncing...', 'orange');

    try {
        let token = localStorage.getItem('googleAccessToken');
        
        // If not running in background (user click) and no token, init flow
        if (!token && !background) {
            const client = await initGapiClient();
            if (!client) throw new Error("GAPI Init Failed");
            
            await new Promise((res, rej) => {
                client.callback = (resp) => {
                    if (resp.error) rej(resp.error);
                    token = resp.access_token;
                    localStorage.setItem('googleAccessToken', token);
                    res();
                };
                client.requestAccessToken({prompt: ''});
            });
        }
        
        if (!token) return; 

        // Profile
        try {
            const pRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { 
                headers: {Authorization: `Bearer ${token}`}
            });
            if (pRes.ok) {
                const p = await pRes.json();
                localStorage.setItem('userName', p.name);
                localStorage.setItem('userAvatar', p.picture);
                updateAuthUI(true, p.name, p.picture);
            }
        } catch(e){}

        // Calendar
        const min = new Date(Date.now() - 30*86400000).toISOString();
        const max = new Date(Date.now() + 90*86400000).toISOString();
        const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(min)}&timeMax=${encodeURIComponent(max)}&showDeleted=false&singleEvents=true&orderBy=startTime&access_token=${token}`);
        
        if (!calRes.ok) {
            if (calRes.status === 401) logout(); 
            throw new Error(calRes.statusText);
        }

        const events = (await calRes.json()).items || [];
        for (const ev of events) {
            const date = ev.start.date || ev.start.dateTime;
            if (!date) continue;
            const key = getKey(new Date(date));
            const existing = db[key]?.content || '';
            const summary = ev.summary || '';
            
            if (!existing.includes(summary)) {
                const newContent = existing ? `${existing}\n${summary}` : summary;
                await upsertNote(key, newContent, summary, db[key]?.tags||[]);
                db[key] = { ...db[key], content: newContent, event_name: summary };
            }
        }

        statusFn('Synced', 'green');
        if (!background) setTimeout(() => statusFn('☁', ''), 2000);
        render();
        updateNoteList();

    } catch (e) {
        console.error(e);
        statusFn('Failed', 'red');
    } finally {
        isSyncing = false;
    }
}

function updateSyncStatus(msg, color) {
    const el = document.getElementById('syncStatus');
    if (el) { el.textContent = msg; el.style.color = color; }
}

async function initGapiClient() {
    // Wait for both gapi and google.accounts to be available
    if (!gapiReady) {
        await new Promise(r => {
            const i = setInterval(() => { 
                if (window.gapi && window.google && window.google.accounts) { 
                    clearInterval(i); 
                    gapiReady = true; 
                    r(); 
                }
            }, 100);
        });
    }
    
    // Load the client module if not already loaded
    await new Promise((resolve, reject) => {
        window.gapi.load('client', {
            callback: resolve,
            onerror: reject,
            timeout: 5000,
            ontimeout: reject
        });
    });
    
    // Initialize the gapi client
    await window.gapi.client.init({
        apiKey: import.meta.env.VITE_GOOGLE_API_KEY,
        discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest"],
    });
    
    // Return the token client
    return window.google.accounts.oauth2.initTokenClient({
        client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
        scope: GOOGLE_SCOPES,
        callback: ''
    });
}

// Legacy function - no longer used since we switched to individual notes
async function upsertNote(key, content, eventName, tags) {
    // Notes are now managed individually via cyclic_note_items
    console.log("upsertNote deprecated - use individual note functions instead");
}

async function saveData() {
    if (!activeKey) return;
    const noteArea = document.getElementById('noteArea');
    const content = noteArea.value.trim();
    if (!content) return;
    
    try {
        // Check if we're editing an existing note
        const editingNoteId = noteArea.dataset.editingNoteId;
        
        if (editingNoteId) {
            // Update existing note
            await updateNoteContent(editingNoteId, content);
            delete noteArea.dataset.editingNoteId;
        } else {
            // Split content by lines and create new notes
            const lines = content.split('\n').filter(line => line.trim() !== '');
            
            // Get current notes count for position offset
            const currentNotes = db[activeKey]?.notes || [];
            const startPosition = currentNotes.length;
            
            // Create new notes (append, don't replace)
            const newNotes = [];
            for (let i = 0; i < lines.length; i++) {
                const { data, error } = await supabase
                    .from('cyclic_note_items')
                    .insert({ date_key: activeKey, content: lines[i].trim(), position: startPosition + i })
                    .select()
                    .single();
                
                if (error) throw error;
                newNotes.push({ id: data.id, content: data.content, position: data.position });
            }
            
            // Update local db
            if (!db[activeKey]) {
                db[activeKey] = { notes: [], event_name: '', tags: [] };
            }
            db[activeKey].notes = [...currentNotes, ...newNotes];
        }
        
        // Clear textarea after saving
        noteArea.value = '';
        noteArea.placeholder = 'Type here to add a new note...';
        
        render();
        updateNoteList();
        console.log("Saved", activeKey);
    } catch(e) { 
        console.error("Save error", e); 
    }
}

async function saveFromFocus() {
    const content = document.getElementById('focusNoteArea').value;
    if (!activeKey) return;
    
    db[activeKey] = { ...db[activeKey], content };
    if (document.getElementById('noteArea')) document.getElementById('noteArea').value = content;
    render();
    updateNoteList();

    try {
        await upsertNote(activeKey, content, db[activeKey]?.event_name, db[activeKey]?.tags);
        console.log("Focused Save", activeKey);
    } catch(e) { console.error(e); }
}

async function deleteNote(key) {
    if (!confirm('Delete all notes for this day?')) return;
    try {
        // Delete all individual note items for this date
        if (db[key] && db[key].notes) {
            for (const note of db[key].notes) {
                await deleteNoteItem(note.id, key);
            }
        }
    } catch(e) { console.error(e); }
}

// Sidebar
function renderNoteList(query = "") {
    updateNoteList(query);
}

// Expose global for inline HTML handlers
window.calendarApp = { deleteNote };

// --- DRAG AND DROP HANDLERS ---
let draggedElement = null;

function handleDragStart(e) {
    draggedElement = e.target;
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', e.target.innerHTML);
}

function handleDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    e.dataTransfer.dropEffect = 'move';
    
    const target = e.target.closest('.week-note-item');
    if (target && target !== draggedElement) {
        target.classList.add('drag-over');
    }
    return false;
}

function handleDrop(e) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }
    e.preventDefault();

    const target = e.target.closest('.week-note-item');
    if (draggedElement && target && draggedElement !== target) {
        // Check if same day
        const draggedKey = draggedElement.dataset.dateKey;
        const targetKey = target.dataset.dateKey;
        
        if (draggedKey === targetKey) {
            // Reorder within same day
            const notesArea = target.parentNode;
            const allNotes = Array.from(notesArea.querySelectorAll('.week-note-item'));
            const draggedIndex = allNotes.indexOf(draggedElement);
            const targetIndex = allNotes.indexOf(target);
            
            if (draggedIndex < targetIndex) {
                target.after(draggedElement);
            } else {
                target.before(draggedElement);
            }
            
            // Update positions in database
            updateNotePositions(draggedKey, notesArea);
        }
    }

    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    return false;
}

function handleDragEnd(e) {
    e.target.classList.remove('dragging');
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
}

// --- NOTE CRUD OPERATIONS ---

async function addNewNote(dateKey) {
    const content = "New note";
    const position = db[dateKey]?.notes?.length || 0;
    
    try {
        const { data, error } = await supabase
            .from('cyclic_note_items')
            .insert({ date_key: dateKey, content, position })
            .select()
            .single();
        
        if (error) throw error;
        
        if (!db[dateKey]) {
            db[dateKey] = { notes: [], event_name: '', tags: [] };
        }
        db[dateKey].notes.push({
            id: data.id,
            content: data.content,
            position: data.position
        });
        
        render();
    } catch (err) {
        console.error("Failed to add note:", err);
    }
}

async function deleteNoteItem(noteId, dateKey) {
    try {
        const { error } = await supabase
            .from('cyclic_note_items')
            .delete()
            .eq('id', noteId);
        
        if (error) throw error;
        
        if (db[dateKey]) {
            db[dateKey].notes = db[dateKey].notes.filter(n => n.id !== noteId);
        }
        
        render();
        updateNoteList(); // Refresh sidebar
    } catch (err) {
        console.error("Failed to delete note:", err);
    }
}

// Stub function for sidebar note list (can be enhanced later)
function updateNoteList(query = "") {
    const list = document.getElementById('noteList');
    if (!list) return;
    
    list.innerHTML = '';
    const lower = query.trim().toLowerCase();
    
    if (!activeKey || !db[activeKey]) {
        list.innerHTML = '<div style="padding: 12px; color: var(--text-light); font-size: 12px;">Select a day to see notes</div>';
        return;
    }
    
    const dayData = db[activeKey];
    const notes = dayData.notes || [];
    
    if (notes.length === 0) {
        list.innerHTML = '<div style="padding: 12px; color: var(--text-light); font-size: 12px;">No notes for this day</div>';
        return;
    }
    
    notes.forEach((note, index) => {
        const noteItem = document.createElement('div');
        noteItem.className = 'note-item';
        noteItem.dataset.noteId = note.id;
        noteItem.dataset.dateKey = activeKey;
        noteItem.draggable = true;
        
        const content = note.content || '';
        const tags = content.match(/#[\w-]+/g) || [];
        const textWithoutTags = content.replace(/#[\w-]+/g, '').trim();
        const tagText = tags.join(' ').toLowerCase();

        if (lower && !content.toLowerCase().includes(lower) && !tagText.includes(lower)) {
            return;
        }
        
        const tagsHtml = tags.length > 0 
            ? `<div class="note-tags">${tags.map(tag => {
                const color = getTagColor(tag);
                return `<span class="tag" style="background: ${color.bg}; color: ${color.text}">${tag}</span>`;
            }).join('')}</div>`
            : '';
        
        noteItem.innerHTML = `
            <div class="note-preview">${textWithoutTags || '(empty note)'}</div>
            ${tagsHtml}
            <button class="sidebar-note-delete" data-note-id="${note.id}" style="position: absolute; top: 8px; right: 8px; background: transparent; border: none; cursor: pointer; font-size: 14px; opacity: 0.5;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.5'" title="Delete note">🗑️</button>
            <div class="delete-confirm" style="display: none; position: absolute; top: 30px; right: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 100;">
                <div style="font-size: 12px; margin-bottom: 8px; color: var(--text-main);">Delete?</div>
                <button class="confirm-yes" style="background: #dc3545; color: white; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; margin-right: 4px; font-size: 11px; font-weight: 600;">Yes</button>
                <button class="confirm-no" style="background: var(--hover); color: var(--text-main); border: 1px solid var(--border); padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 11px;">No</button>
            </div>
        `;
        
        // Click to edit note
        noteItem.onclick = (e) => {
            if (e.target.classList.contains('sidebar-note-delete') || e.target.classList.contains('confirm-yes') || e.target.classList.contains('confirm-no') || e.target.closest('.delete-confirm')) return;
            const noteArea = document.getElementById('noteArea');
            if (noteArea) {
                noteArea.value = content;
                noteArea.focus();
                noteArea.dataset.editingNoteId = note.id;
            }
        };
        
        // Delete button - show confirmation popup
        const deleteBtn = noteItem.querySelector('.sidebar-note-delete');
        const confirmDiv = noteItem.querySelector('.delete-confirm');
        const yesBtn = noteItem.querySelector('.confirm-yes');
        const noBtn = noteItem.querySelector('.confirm-no');
        
        deleteBtn.onclick = async (e) => {
            e.stopPropagation();
            confirmDiv.style.display = 'block';
        };
        
        yesBtn.onclick = async (e) => {
            e.stopPropagation();
            await deleteNoteItem(note.id, activeKey);
        };
        
        noBtn.onclick = (e) => {
            e.stopPropagation();
            confirmDiv.style.display = 'none';
        };

        // Drag to reorder within sidebar list
        noteItem.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', note.id);
            noteItem.classList.add('dragging');
        });
        noteItem.addEventListener('dragend', () => {
            noteItem.classList.remove('dragging');
            list.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        });
        noteItem.addEventListener('dragover', (e) => {
            e.preventDefault();
            noteItem.classList.add('drag-over');
        });
        noteItem.addEventListener('dragleave', () => {
            noteItem.classList.remove('drag-over');
        });
        noteItem.addEventListener('drop', (e) => {
            e.preventDefault();
            noteItem.classList.remove('drag-over');
            const dragged = list.querySelector('.dragging');
            if (dragged && dragged !== noteItem) {
                const isAfter = dragged.compareDocumentPosition(noteItem) & Node.DOCUMENT_POSITION_FOLLOWING;
                if (isAfter) {
                    noteItem.after(dragged);
                } else {
                    noteItem.before(dragged);
                }
                updateSidebarNotePositions(activeKey, list);
            }
        });
        
        list.appendChild(noteItem);
    });
}

async function updateNoteContent(noteId, newContent) {
    try {
        const { error } = await supabase
            .from('cyclic_note_items')
            .update({ content: newContent })
            .eq('id', noteId);
        
        if (error) throw error;
        
        // Update local db
        for (let key in db) {
            const note = db[key].notes.find(n => n.id === noteId);
            if (note) {
                note.content = newContent;
                break;
            }
        }
    } catch (err) {
        console.error("Failed to update note:", err);
    }
}

async function updateNotePositions(dateKey, notesArea) {
    const noteElements = Array.from(notesArea.querySelectorAll('.week-note-item'));
    const updates = noteElements.map((el, index) => ({
        id: el.dataset.noteId,
        position: index
    }));
    
    try {
        // Update in database
        for (const update of updates) {
            await supabase
                .from('cyclic_note_items')
                .update({ position: update.position })
                .eq('id', update.id);
        }
        
        // Update local db
        if (db[dateKey]) {
            db[dateKey].notes.forEach(note => {
                const update = updates.find(u => u.id === note.id);
                if (update) {
                    note.position = update.position;
                }
            });
            db[dateKey].notes.sort((a, b) => a.position - b.position);
        }
    } catch (err) {
        console.error("Failed to update positions:", err);
    }
}

async function updateSidebarNotePositions(dateKey, listEl) {
    const noteElements = Array.from(listEl.querySelectorAll('.note-item'));
    const updates = noteElements.map((el, index) => ({
        id: el.dataset.noteId,
        position: index
    }));

    try {
        for (const update of updates) {
            await supabase
                .from('cyclic_note_items')
                .update({ position: update.position })
                .eq('id', update.id);
        }

        if (db[dateKey]) {
            db[dateKey].notes.forEach(note => {
                const update = updates.find(u => u.id === note.id);
                if (update) {
                    note.position = update.position;
                }
            });
            db[dateKey].notes.sort((a, b) => a.position - b.position);
        }
    } catch (err) {
        console.error('Failed to update sidebar positions:', err);
    }
}

init();
