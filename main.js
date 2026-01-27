import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_ANON_KEY
)

let db = {};
let activeKey = null;
let showRealDates = true;  
let showCycleDays = false; 

// ZOOM STATE
let viewLevel = 0; 
let focusRefs = { q: null, cycleIdx: null, weekNum: null };
let isZooming = false; // Debounce flag

const tagColors = {};
let anchorDate = new Date(localStorage.getItem('calendarAnchorDate') || '2025-12-29');

const timespans = [
    {name: "Q1C1", len: 28}, {name: "Q1C2", len: 28}, {name: "Q1C3", len: 28}, {name: "Reset 1", len: 7},
    {name: "Q2C1", len: 28}, {name: "Q2C2", len: 28}, {name: "Q2C3", len: 28}, {name: "Reset 2", len: 7},
    {name: "Q3C1", len: 28}, {name: "Q3C2", len: 28}, {name: "Q3C3", len: 28}, {name: "Reset 3", len: 7},
    {name: "Q4C1", len: 28}, {name: "Q4C2", len: 28}, {name: "Q4C3", len: 28}, {name: "Reset 4", len: 7}
];

// --- ZOOM LOGIC ---

function updateZoomUI() {
    const main = document.getElementById('main');
    main.className = `view-level-${viewLevel}`;
    const backBtn = document.getElementById('zoomOutBtn');
    if (backBtn) backBtn.style.display = viewLevel > 0 ? 'block' : 'none';
}

function zoomOut() {
    if (viewLevel > 0) {
        viewLevel--;
        render();
        updateZoomUI();
    }
}

/**
 * WHEEL HANDLER
 * deltaY < 0 is Scroll Up (Zoom In)
 * deltaY > 0 is Scroll Down (Zoom Out)
 */
function handleWheel(e) {
    e.preventDefault(); // Stop page from jumping
    if (isZooming) return;

    if (e.deltaY < 0) {
        // ZOOM IN
        if (viewLevel < 4) {
            const hoveredDay = e.target.closest('.day');
            const hoveredCycle = e.target.closest('.month-wrapper');
            const hoveredQuarter = e.target.closest('.quarter-group');

            if (viewLevel === 0 && hoveredQuarter) {
                const allQs = [...document.querySelectorAll('.quarter-group')];
                focusRefs.q = allQs.indexOf(hoveredQuarter);
                viewLevel = 1;
            } 
            else if (viewLevel === 1 && hoveredCycle) {
                const allCs = [...document.querySelectorAll('.month-wrapper')];
                focusRefs.cycleIdx = allCs.indexOf(hoveredCycle);
                viewLevel = 2;
            }
            else if (viewLevel === 2 && hoveredDay) {
                // More accurate week calculation for focus
                const dayIndex = Array.from(hoveredDay.parentNode.children).indexOf(hoveredDay);
                // Skip header elements to calculate week correctly
                const siblings = Array.from(hoveredDay.parentNode.children);
                const dayPosition = siblings.indexOf(hoveredDay);
                // Account for the month-header and weekday-header elements
                focusRefs.weekNum = Math.ceil((dayPosition - 1) / 7); // -1 because we skip the header
                viewLevel = 3;
            }
            else if (viewLevel === 3 && hoveredDay) {
                // When at level 3, clicking on a day should go to level 4
                // Store information about which day was clicked for level 4
                const dayDate = hoveredDay.querySelector('.real-date')?.textContent;
                if (dayDate) {
                    // Find the date corresponding to this day
                    const parentGrid = hoveredDay.closest('.month-grid');
                    const dayIndex = Array.from(parentGrid.children).indexOf(hoveredDay);
                    // Calculate the date based on the current rendering
                    let tempDate = new Date(anchorDate);
                    // Count days until we reach the focused quarter and cycle
                    for (let q = 0; q < 4; q++) {
                        for (let sIdx = 0; sIdx < 4; sIdx++) {
                            const span = timespans[q * 4 + sIdx];
                            if (focusRefs.cycleIdx === q * 4 + sIdx) {
                                // We found the right cycle, now move to the right day
                                for (let d = 0; d < dayIndex; d++) {
                                    tempDate.setDate(tempDate.getDate() + 1);
                                }
                                break;
                            } else {
                                tempDate.setDate(tempDate.getDate() + span.len);
                            }
                        }
                    }
                    viewLevel = 4;
                }
            }
            else if (viewLevel === 3) {
                viewLevel = 4;
            }
            executeZoom();
        }
    } else {
        // ZOOM OUT
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
    // Debounce to prevent level skipping
    setTimeout(() => { isZooming = false; }, 200);
}

// --- HELPER FUNCTIONS ---

function getFormattedCyclicDate(targetDateKey) {
    let run = new Date(anchorDate);
    for (let q = 0; q < 4; q++) {
        for (let sIdx = 0; sIdx < 4; sIdx++) {
            const span = timespans[q * 4 + sIdx];
            for (let d = 1; d <= span.len; d++) {
                const key = `${run.getFullYear()}-${run.getMonth()+1}-${run.getDate()}`;
                if (key === targetDateKey) {
                    const week = Math.ceil(d / 7);
                    const dayInWeek = ((d - 1) % 7) + 1;
                    const cyclePart = span.name.includes('Reset') ? 'R' : span.name.split('Q' + (q+1))[1];
                    return `Q${q+1}.${cyclePart}.W${week}.D${dayInWeek}`;
                }
                run.setDate(run.getDate() + 1);
            }
        }
    }
    return "";
}

// --- CORE FUNCTIONALITY ---

async function saveData() {
    if (!activeKey) return;
    const content = document.getElementById('noteArea').value;
    const event_name = document.getElementById('eventInput').value;
    
    try {
        await supabase.from('cyclic_notes').upsert({
            date_key: activeKey, 
            content, 
            event_name, 
            tags: content.match(/#\w+/g) || []
        });
        db[activeKey] = { ...db[activeKey], content, event_name };
        render(); 
    } catch (err) {
        console.error("Save failed:", err);
    }
}

// --- RENDERING ---

function render() {
    const container = document.getElementById('calContainer');
    if (!container) return;
    container.innerHTML = "";
    
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}`;
    let run = new Date(anchorDate);
    const weekDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

    // Handle level 4 (day focus view) separately
    if (viewLevel === 4) {
        // Populate the day focus view with the selected day's content
        const dayFocusHeader = document.getElementById('dayFocusHeader');
        const dayFocusSubheader = document.getElementById('dayFocusSubheader');
        const dayFocusContent = document.getElementById('dayFocusContent');
        
        if (dayFocusHeader && dayFocusSubheader && dayFocusContent && activeKey) {
            // Parse activeKey to get the date
            const [year, month, day] = activeKey.split('-').map(Number);
            const activeDate = new Date(year, month - 1, day);
            
            dayFocusHeader.textContent = `${activeDate.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;
            dayFocusSubheader.textContent = getFormattedCyclicDate(activeKey);
            
            // Get the content for the active day
            const dayData = db[activeKey] || {};
            dayFocusContent.textContent = dayData.content || "No notes for this day";
        }
        return; // Exit early since level 4 doesn't need calendar rendering
    }

    for (let q = 0; q < 4; q++) {
        if (viewLevel >= 1 && focusRefs.q !== q) {
            timespans.slice(q*4, q*4+4).forEach(s => run.setDate(run.getDate() + s.len));
            continue; 
        }

        const quarterDiv = document.createElement('div');
        quarterDiv.className = 'quarter-group';
        
        timespans.slice(q * 4, q * 4 + 4).forEach((s, sIdx) => {
            const globalSIdx = q * 4 + sIdx;

            if (viewLevel >= 2 && focusRefs.cycleIdx !== globalSIdx) {
                run.setDate(run.getDate() + s.len);
                return;
            }

            const blockWrapper = document.createElement('div');
            blockWrapper.className = 'month-wrapper';
            
            let cycleClass = s.name.includes('C1') ? 'bg-c1' : s.name.includes('C2') ? 'bg-c2' : s.name.includes('C3') ? 'bg-c3' : 'bg-reset';
            blockWrapper.innerHTML = `
                <div class="month-header ${cycleClass}">${s.name}</div>
                <div class="weekday-header">${weekDays.map(day => `<div>${day}</div>`).join('')}</div>
                <div class="month-grid"></div>
            `;
            
            const grid = blockWrapper.querySelector('.month-grid');

            for (let i = 1; i <= s.len; i++) {
                const key = `${run.getFullYear()}-${run.getMonth()+1}-${run.getDate()}`;
                const weekNum = Math.ceil(i / 7);

                if (viewLevel >= 3 && focusRefs.weekNum !== weekNum) {
                    run.setDate(run.getDate() + 1);
                    continue;
                }

                const dayData = db[key] || {};
                const d = document.createElement('div');
                d.className = `day ${cycleClass} ${key === todayKey ? 'is-today' : ''} ${key === activeKey ? 'active' : ''}`;
                
                const inlineNote = (viewLevel === 3 && dayData.content) 
                    ? `<div class="day-content-preview" style="font-size:10px; padding:5px; opacity:0.8;">${dayData.content.substring(0, 50)}...</div>` 
                    : '';

                d.innerHTML = `
                    ${showCycleDays ? `<div class="cycle-num">${i}</div>` : ''}
                    ${showRealDates ? `<div class="real-date">${run.getDate()}</div>` : ''}
                    ${inlineNote}
                    <div class="dot-row">${dayData.content ? `<div class="dot dot-note"></div>` : ''}</div>
                `;

                d.onclick = (e) => {
                    e.stopPropagation();
                    activeKey = key;
                    document.getElementById('selLabel').innerText = `${key} (${getFormattedCyclicDate(key)})`;
                    document.getElementById('noteArea').value = dayData.content || "";
                    document.getElementById('eventInput').value = dayData.event_name || "";
                    
                    // If we're at level 3 and click a day, go to level 4 (day focus view)
                    if (viewLevel === 3) {
                        viewLevel = 4;
                        updateZoomUI();
                        
                        // Populate the day focus view with the selected day's content
                        const dayFocusHeader = document.getElementById('dayFocusHeader');
                        const dayFocusSubheader = document.getElementById('dayFocusSubheader');
                        const dayFocusContent = document.getElementById('dayFocusContent');
                        
                        if (dayFocusHeader && dayFocusSubheader && dayFocusContent) {
                            dayFocusHeader.textContent = `${run.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;
                            dayFocusSubheader.textContent = getFormattedCyclicDate(key);
                            dayFocusContent.textContent = dayData.content || "No notes for this day";
                        }
                    }
                    
                    render();
                };
                
                grid.appendChild(d);
                run.setDate(run.getDate() + 1); 
            }
            quarterDiv.appendChild(blockWrapper);
        });
        container.appendChild(quarterDiv);
    }
}

// --- INITIALIZATION ---

async function init() {
    // 1. ADD WHEEL LISTENER
    const mainElement = document.getElementById('main');
    if (mainElement) {
        mainElement.addEventListener('wheel', handleWheel, { passive: false });
    }

    const zb = document.getElementById('zoomOutBtn');
    if (zb) zb.onclick = zoomOut;

    const saveBtn = document.getElementById('saveNoteBtn');
    if (saveBtn) saveBtn.onclick = saveData;

    document.getElementById('toggleRealDate').onchange = (e) => { showRealDates = e.target.checked; render(); };
    document.getElementById('toggleCycleNum').onchange = (e) => { showCycleDays = e.target.checked; render(); };
    
    // Auth & Data Fetch
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
        const { data } = await supabase.from('cyclic_notes').select('*');
        if (data) db = data.reduce((acc, row) => ({ ...acc, [row.date_key]: row }), {});
    }

    render();
    updateZoomUI();
}

init();