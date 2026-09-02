// Regression checks for the compact Timeline and date-circle disclosure.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('public/WayPoint/index.html', 'utf8');
const eventStart = source.indexOf('function eventRowHtml');
const eventEnd = source.indexOf('function timelineDaySeed', eventStart);
const timelineStart = source.indexOf('function renderTimelineTab');
const timelineEnd = source.indexOf('/* ---------- 21.', timelineStart);
const eventRenderer = source.slice(eventStart, eventEnd);
const timelineRenderer = source.slice(timelineStart, timelineEnd);

assert(eventRenderer.includes('model.metadata = {};'), 'Timeline rows still expose ItemRow metadata tags');
assert(!timelineRenderer.includes('areasForDay('), 'Timeline day headings still resolve destinations');
assert(!timelineRenderer.includes('day-areas'), 'Timeline day headings still render destination chips');
assert(timelineRenderer.includes('data-action="toggle-timeline-day"'), 'Date circle is not a disclosure button');
assert(source.includes("day >= (today || timelineLocalTodayStr())"), 'Past-day default is missing');
assert(source.includes("action === 'toggle-timeline-day' && trip"), 'Timeline disclosure action is not wired');
assert(source.includes('timelineContent.hidden = !nextExpanded'), 'Timeline disclosure does not hide its controlled content');

const stateStart = source.indexOf('var timelineDayExpansion = {}');
const stateEnd = source.indexOf('// ---- Accounts / login', stateStart);
assert(stateStart !== -1 && stateEnd !== -1, 'Could not locate Timeline disclosure state');
const context = {};
vm.createContext(context);
vm.runInContext(source.slice(stateStart, stateEnd), context);

assert.strictEqual(context.timelineDayExpanded('trip-1', '2026-09-01', '2026-09-02'), false, 'A day before today should default closed');
assert.strictEqual(context.timelineDayExpanded('trip-1', '2026-09-02', '2026-09-02'), true, 'Today should default open');
assert.strictEqual(context.timelineDayExpanded('trip-1', '2026-09-03', '2026-09-02'), true, 'A future day should default open');
context.timelineDayExpansion[context.timelineDayKey('trip-1', '2026-09-01')] = true;
assert.strictEqual(context.timelineDayExpanded('trip-1', '2026-09-01', '2026-09-02'), true, 'Manual expansion should override the date default');

console.log('condensed Timeline and day disclosure checks passed');
