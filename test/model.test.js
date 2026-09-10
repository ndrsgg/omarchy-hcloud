// Standalone node test for the plugin's pure logic and its theme discipline.
// Run with `node test/model.test.js` — no dependencies, no Qt.

const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const Model = require(path.join(root, 'Model.js'))

let failures = 0
let checks = 0

function assert(condition, message) {
  checks++
  if (!condition) {
    failures++
    console.error('FAIL  ' + message)
  }
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, message + '\n        expected: ' + JSON.stringify(expected) + '\n        actual:   ' + JSON.stringify(actual))
}

function assertDeepEqual(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message + '\n        expected: ' + JSON.stringify(expected) + '\n        actual:   ' + JSON.stringify(actual))
}

// ---------------------------------------------------------------- fixtures

// Shaped after a real GET /v1/servers response, trimmed to the fields the
// panel reads.
const rawServer = {
  id: 42,
  name: 'web-1',
  status: 'running',
  created: '2026-03-11T09:14:02+00:00',
  locked: false,
  backup_window: '22-02',
  outgoing_traffic: 536870912000,
  ingoing_traffic: 10737418240,
  included_traffic: 21990232555520,
  public_net: {
    ipv4: { ip: '203.0.113.10', dns_ptr: 'static.10.113.0.203.clients.your-server.de' },
    ipv6: { ip: '2001:db8:1234:5678::/64' }
  },
  private_net: [{ ip: '10.0.0.4' }],
  server_type: { name: 'cpx21', cores: 3, memory: 4, disk: 80 },
  datacenter: { name: 'fsn1-dc14', location: { city: 'Falkenstein', country: 'DE' } },
  image: { name: 'ubuntu-24.04', description: 'Ubuntu 24.04' },
  labels: { env: 'prod', team: 'web' }
}

const bridgeOutput = JSON.stringify({
  ok: true,
  projects: [
    { label: 'production', ok: true, status: 200, error: '', servers: [
      rawServer,
      Object.assign({}, rawServer, { id: 43, name: 'db-1', status: 'off', public_net: { ipv4: { ip: '203.0.113.11' }, ipv6: { ip: '' } }, private_net: [] })
    ] },
    { label: 'staging', ok: false, status: 401, error: 'the token you have provided is invalid', servers: [] }
  ]
})

// ---------------------------------------------------------------- tones

assertEqual(Model.statusTone('running'), 'live', 'a running server has its own state, not the text colour')
assertEqual(Model.statusTone('off'), 'off', 'a stopped server is dimmed')
assertEqual(Model.statusTone('starting'), 'busy', 'starting is a transition')
assertEqual(Model.statusTone('stopping'), 'busy', 'stopping is a transition')
assertEqual(Model.statusTone('rebuilding'), 'busy', 'rebuilding is a transition')
assertEqual(Model.statusTone('unknown'), 'bad', 'an unknown state is urgent')
assertEqual(Model.statusTone(''), 'bad', 'a missing state is urgent rather than silently passing')
assert(Model.isTransitional('migrating') && !Model.isTransitional('running'), 'only transitions pulse')
// A running machine must not be painted in the same colour as the text beside
// it, or a healthy fleet says nothing at all.
assert(!/if \(tone === "live"\) return foreground/.test(fs.readFileSync(path.join(root, 'Panel.qml'), 'utf8')),
  'a live machine does not take the plain foreground')
// Renaming the tones left fallbacks behind that no longer matched any branch
// and silently fell through to the healthy colour.
const toneNames = ['live', 'off', 'busy', 'bad']
const toneUses = (fs.readFileSync(path.join(root, 'Panel.qml'), 'utf8').match(/toneColor\([^)]*"(\w+)"\)/g) || [])
  .map(m => m.match(/"(\w+)"/)[1])
assert(toneUses.every(name => toneNames.indexOf(name) !== -1),
  'every literal tone handed to toneColor is one it knows: ' + toneUses.join(', '))

// ---------------------------------------------------------------- formatting

assertEqual(Model.formatBytes(0), '', 'zero bytes render as nothing, not "0 B"')
assertEqual(Model.formatBytes(1024), '1 KB', 'formatBytes scales to KB')
assertEqual(Model.formatBytes(536870912000), '500 GB', 'formatBytes scales to GB')
assertEqual(Model.formatBytes(21990232555520), '20 TB', 'formatBytes scales to TB')
assertEqual(Model.formatMemory(4), '4 GB', 'whole gigabytes lose the decimal')
assertEqual(Model.formatMemory(1.5), '1.5 GB', 'fractional memory keeps one decimal')
assertEqual(Model.formatCreated('2026-03-11T09:14:02+00:00'), '2026-03-11', 'created collapses to a date')
assertEqual(Model.formatCreated('nonsense'), 'nonsense', 'an unparseable date passes through untouched')

// ---------------------------------------------------------------- normalize

const server = Model.normalizeServer(rawServer, 'production')
assertEqual(server.name, 'web-1', 'normalizeServer keeps the name')
assertEqual(server.project, 'production', 'normalizeServer stamps the project label')
assertEqual(server.tone, 'live', 'normalizeServer resolves the tone once')
assertEqual(server.ipv4, '203.0.113.10', 'normalizeServer lifts the public IPv4')
assertEqual(server.ipv6, '2001:db8:1234:5678::/64', 'normalizeServer lifts the public IPv6')
assertEqual(server.privateIp, '10.0.0.4', 'normalizeServer lifts the first private IP')
assertEqual(server.location, 'Falkenstein, DE', 'normalizeServer joins city and country')
assertEqual(server.image, 'Ubuntu 24.04', 'normalizeServer prefers the image description')
assertDeepEqual(server.labels, [{ key: 'env', value: 'prod' }, { key: 'team', value: 'web' }], 'normalizeServer sorts labels by key')

const bare = Model.normalizeServer({}, 'p')
assertEqual(bare.name, 'Unnamed', 'a nameless server still renders')
assertEqual(bare.status, 'unknown', 'a stateless server is unknown, not blank')
assertDeepEqual(bare.privateIps, [], 'a server with no private net yields no private IPs')

assert(Model.serverMeta(server).indexOf('203.0.113.10') === 0, 'the subtitle leads with the IPv4')
assert(Model.serverMeta(server).indexOf('3 vCPU') !== -1, 'the subtitle carries the core count')
assert(Model.serverMeta(server).indexOf('Falkenstein, DE') !== -1, 'the subtitle carries the location')

const details = Model.serverDetails(server)
const detailKeys = details.map(row => row.key)
assert(detailKeys.indexOf('Image') !== -1, 'details show the image')
assert(detailKeys.indexOf('Traffic out') !== -1, 'details show outgoing traffic')
assertEqual(details.filter(row => row.key === 'Traffic out')[0].value, '500 GB of 20 TB', 'traffic is shown against the included allowance')

// ---------------------------------------------------------------- copy

assertDeepEqual(
  Model.copyOptions(server, 'production').map(option => option.kind),
  ['ipv4', 'name', 'ipv6', 'private', 'ssh'],
  'the copy menu offers every address the server actually has'
)
assertDeepEqual(
  Model.copyOptions(Model.normalizeServer({ name: 'lonely' }, 'p'), '').map(option => option.kind),
  ['name'],
  'the copy menu leaves out what the server does not have'
)
assertEqual(Model.copyValue(server, 'ipv4', 'production'), '203.0.113.10', 'copying IPv4 yields the address')
assertEqual(Model.copyValue(server, 'ssh', 'production'), 'production/web-1', 'the ssh alias is prefix/name')
assertEqual(Model.sshAlias('', 'web-1'), 'web-1', 'an empty prefix yields the bare name')
assertEqual(Model.copyValue(server, 'nope', ''), '', 'an unknown copy kind yields nothing')

// ---------------------------------------------------------------- search

assert(Model.matchesQuery(server, ''), 'an empty query matches everything')
assert(Model.matchesQuery(server, 'WEB'), 'search is case insensitive')
assert(Model.matchesQuery(server, '203.0.113'), 'search covers addresses')
assert(Model.matchesQuery(server, 'cpx21'), 'search covers the server type')
assert(Model.matchesQuery(server, 'env=prod'), 'search covers labels')
assert(!Model.matchesQuery(server, 'nothing-like-this'), 'a miss is a miss')

// ---------------------------------------------------------------- bridge

const parsed = Model.parseBridge(bridgeOutput)
assert(parsed.ok, 'a well-formed bridge document parses')
assertEqual(parsed.projects.length, 2, 'every labelled project comes through')
assertDeepEqual(parsed.projects[0].servers.map(s => s.name), ['db-1', 'web-1'], 'servers are sorted by name inside a project')
assertEqual(parsed.projects[1].ok, false, 'a failed project stays marked as failed')
assertEqual(parsed.projects[1].status, 401, 'the HTTP status survives for the panel to explain')

assertEqual(Model.parseBridge('').ok, false, 'no output is an error, not an empty tailnet')
assertEqual(Model.parseBridge('not json').ok, false, 'unparseable output is an error')
assertEqual(Model.parseBridge('{"ok":false,"error":"secret-tool not found"}').error, 'secret-tool not found', 'a bridge error message is passed through verbatim')

// ---------------------------------------------------------------- grouping

const groups = Model.buildGroups(parsed.projects, '')
assertEqual(groups.total, 2, 'the total counts servers, not projects')
assertEqual(groups.failed, 1, 'the failed count notices the 401')
assertDeepEqual(groups.groups.map(g => g.offset), [0, 2], 'row offsets run across project boundaries')
assertEqual(Model.flatServers(groups).length, 2, 'flatServers walks every group')

// 'db' alone would also match web-1's IPv6 (2001:db8:...), which is correct
// behaviour and a poor fixture — search on the name instead.
const filtered = Model.buildGroups(parsed.projects, 'db-1')
assertEqual(filtered.matched, 1, 'a search narrows the visible rows')
assertEqual(filtered.total, 2, 'a search does not change the underlying total')
assertDeepEqual(filtered.groups.map(g => g.offset), [0, 1], 'offsets are recomputed against the filtered rows')

// A search hides the projects it emptied, but never one that failed to load:
// a broken token vanishing mid-search reads as "that server does not exist".
const searchable = [
  { label: 'wdmr', ok: true, servers: [Model.normalizeServer({ name: 'web' }, 'wdmr')], storageBoxes: [] },
  { label: 'w11k', ok: true, servers: [Model.normalizeServer({ name: 'ansible' }, 'w11k')], storageBoxes: [] },
  { label: 'broken', ok: false, error: '401', servers: [], storageBoxes: [] }
]
assertDeepEqual(Model.buildGroups(searchable, '').groups.map(g => g.hidden), [false, false, false],
  'without a search every project shows, empty or not')
assertDeepEqual(Model.buildGroups(searchable, 'ansib').groups.map(g => g.hidden), [true, false, false],
  'a search hides the projects it emptied but keeps the failed one')
assertEqual(Model.buildGroups(searchable, 'ansib').groups[1].matches, 1, 'a group counts its matches')
assertEqual(Model.summaryText(Model.buildGroups(searchable, 'ansib'), 3, 'ansib'), '1 of 2 servers',
  'the summary counts what survived the search')

assertEqual(Model.summaryText(null, 0), 'No project token yet', 'the summary asks for a token first')
assertEqual(Model.summaryText(null, 1), 'Loading…', 'the summary admits it has not loaded')
assertEqual(Model.summaryText(groups, 2), '2 servers in 2 projects · 1 failed', 'the summary counts servers, projects and failures')
assertEqual(Model.summaryText(Model.buildGroups([{ label: 'a', ok: true, servers: [] }], ''), 1), '0 servers in 1 project', 'the summary gets singular/plural right')

// ------------------------------------------------------------ qml wiring

// A call to a function that was never declared loads as nothing: the widget
// disappears from the bar and the only trace is one line in the shell log.
// Braces balancing says nothing about it, and this is how it got shipped once.
function qmlCode(file) {
  return fs.readFileSync(path.join(root, file), 'utf8').replace(/\/\/[^\n]*/g, '')
}

function declaredIn(code) {
  const names = new Set(['bar', 'moduleName', 'settings', 'ipcTarget', 'manageIpc', 'controller',
    'opened', 'barForeground', 'open', 'close', 'toggle', 'switchPanel', 'setting',
    'width', 'height', 'implicitWidth', 'implicitHeight', 'visible', 'enabled',
    'parent', 'children', 'opacity'])
  for (const m of code.matchAll(/^\s*(?:readonly\s+)?property\s+\S+\s+(\w+)/gm)) names.add(m[1])
  for (const m of code.matchAll(/^\s*function\s+(\w+)/gm)) names.add(m[1])
  for (const m of code.matchAll(/^\s*signal\s+(\w+)/gm)) names.add(m[1])
  return names
}

function referenced(code, receiver) {
  const found = new Set()
  for (const m of code.matchAll(new RegExp('\\b' + receiver + '\\.(\\w+)', 'g'))) found.add(m[1])
  return [...found]
}

for (const file of ['Panel.qml', 'Service.qml', 'HetznerIcon.qml']) {
  const code = qmlCode(file)
  const own = declaredIn(code)
  const dangling = referenced(code, 'root').filter(name => !own.has(name))
  assertDeepEqual(dangling, [], file + ' calls only things it declares')

  const ids = [...code.matchAll(/^\s*id:\s*(\w+)/gm)].map(m => m[1])
  const duplicated = ids.filter((id, i) => ids.indexOf(id) !== i)
  assertDeepEqual([...new Set(duplicated)], [], file + ' declares each id once')
}

// A handler for a property that does not exist is refused by QML at load time,
// and the widget vanishes from the bar with one WARN line in the journal. A
// rename that missed the capitalised handler shipped exactly that once.
for (const file of ['Panel.qml', 'Service.qml', 'HetznerIcon.qml']) {
  const code = qmlCode(file)
  const own = declaredIn(code)
  const known = new Set(['opened', 'visible', 'width', 'height', 'rotation', 'openedChanged', 'containsMouse',
    'hasCursor', 'activeFocus', 'text', 'status', 'running', 'exited', 'started', 'clicked', 'hovered', 'chosen',
    'pressed', 'accepted', 'triggered', 'streamFinished', 'completed', 'destruction', 'moveRequested',
    'activateRequested', 'closeRequested', 'deleteRequested', 'tabRequested', 'textKey', 'tokenStored',
    'tokenRemoved', 'serversLoaded', 'entered', 'textChanged', 'activeItemChanged', 'readyChanged'])
  // Only handlers written at the root's indentation depth are the root's own;
  // deeper ones belong to children whose types this test cannot see.
  const rootHandlers = [...code.matchAll(/^  on([A-Z]\w*)Changed:/gm)].map(m => m[1][0].toLowerCase() + m[1].slice(1))
  assertDeepEqual(rootHandlers.filter(name => !own.has(name) && !known.has(name)), [],
    file + ' has no change handler for a property it does not declare')
}

// Indentation has to agree with the braces. Twice now I checked a structural
// move by reading the indentation, and twice the two had come apart — a block
// landed inside a sibling while still looking like its neighbour. QML nests by
// braces; the indentation is the thing that lies.
function indentOffenders(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8')
  let depth = 0, previous = '', bad = []
  for (const [i, line] of src.split('\n').entries()) {
    const stripped = line.trim()
    if (!stripped || stripped.startsWith('//')) continue
    const code = line.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/\/\/.*$/, '')
    const closesFirst = stripped.startsWith('}') || stripped.startsWith(')')
    const expected = (closesFirst ? depth - 1 : depth) * 2
    const actual = line.length - line.trimStart().length
    // A wrapped expression is legitimately deeper than its nesting.
    const continuation = /^(\?|:|\|\||&&|\+|\.)/.test(stripped)
      || /[(,+?:=]$|&&$|\|\|$/.test(previous)
    if (actual !== expected && !continuation) bad.push(i + 1 + ': ' + stripped.slice(0, 50))
    depth += (code.match(/{/g) || []).length - (code.match(/}/g) || []).length
    previous = stripped
  }
  return bad
}

for (const file of ['Panel.qml', 'Service.qml', 'HetznerIcon.qml']) {
  assertDeepEqual(indentOffenders(file), [], file + ' is indented the way it nests')
}

// The panel reaches across into the service by id; that link breaks the same
// silent way.
const serviceOwn = declaredIn(qmlCode('Service.qml'))
assertDeepEqual(
  referenced(qmlCode('Panel.qml'), 'hcloud').filter(name => !serviceOwn.has(name)),
  [],
  'the panel asks the service only for things it has'
)

// ---------------------------------------------------------------- sources

const panelSource = fs.readFileSync(path.join(root, 'Panel.qml'), 'utf8')
const serviceSource = fs.readFileSync(path.join(root, 'Service.qml'), 'utf8')
const bridgeSource = fs.readFileSync(path.join(root, 'bin', 'omarchy-hcloud-bridge'), 'utf8')

// The widget has to survive any theme, so colors, type sizes and spacing may
// only come from tokens. These four greps are the enforcement.
assert(!/#[0-9A-Fa-f]{3,8}\b/.test(panelSource), 'the panel contains no hex color literals')
assert(!/font\.pixelSize:\s*[0-9]/.test(panelSource), 'the panel sets no raw pixel font sizes')
assert(!/anchors\.[a-zA-Z]*[Mm]argins?:\s*[0-9]/.test(panelSource), 'the panel uses no raw pixel margins')
assert(!/\bspacing:\s*[0-9]/.test(panelSource), 'the panel uses no raw pixel spacing')

// A bar widget is instantiated once per monitor, so the base class must not
// race every screen to register the same IPC target.
// Only the list scrolls. The hero, the message line and the search sit above
// the Flickable, not inside it, so they hold their place while you page
// through a long fleet.
assert(/id: stickyColumn/.test(panelSource), 'the header is a block of its own')
assert(panelSource.indexOf('id: stickyColumn') < panelSource.indexOf('id: panelFlick'),
  'and it sits before the scroll area, not in it')
assert(/stickyColumn\.implicitHeight \+ shellLayout\.spacing \+ column\.implicitHeight/.test(panelSource),
  'the panel is tall enough for the fixed part plus the list')

// Boxes belong to the project whose token reported them.
assert(/model: group\.boxes/.test(panelSource), 'storage boxes render inside their project group')
assert(!/text: "STORAGE BOXES"/.test(panelSource), 'and not in a section of their own')

assert(/manageIpc:\s*false/.test(panelSource), 'the panel leaves IPC registration to the shell')
// The house width. Drifting off it makes the widget look like a stranger next
// to the panels it sits among.
assert(/fittedContentWidth\(Style\.space\(380\)\)/.test(panelSource), 'the panel is as wide as the first-party ones')

// Read-only by design for step 1.
assert(!/poweron|poweroff|\breboot\b|shutdown/i.test(panelSource + serviceSource + bridgeSource),
  'nothing in the plugin can power a server on or off')

// The token must never reach a command line: /proc/<pid>/cmdline is 0444.
assert(/stdinEnabled:\s*true/.test(serviceSource), 'the token reaches the bridge over stdin')
assert(!/secret\s*\+/.test(serviceSource.replace(/write\(secret \+ "\\n"\)/, '')), 'the token is only ever written to stdin')
assert(/bridgeArgs\("store"\)\.concat\(\[key\]\)/.test(serviceSource), 'only the keyring key travels on the bridge command line')
assert(!/Bearer/.test(panelSource + serviceSource), 'no Authorization header is built in QML')
assert(/per_page=%d&page=%d/.test(bridgeSource), 'the bridge paginates explicitly')
assert(/next_page/.test(bridgeSource), 'the bridge follows meta.pagination.next_page')

// Glyphs. Nerd Font characters live in a private use area and are easy to lose
// in transit — an empty `text: ""` on a BarIconButton clears hasVisualContent
// and the widget vanishes from the bar with no error anywhere. Catch that here
// rather than on someone's bar.
assert(!/\b(icon)?[tT]ext:\s*""/.test(panelSource), 'no glyph slot in the panel is empty')

// Omarchy renders with the nf-md block throughout; the legacy Font Awesome
// range below U+F0000 was relocated in Nerd Fonts v3 and shows as tofu.
const strayGlyphs = [...new Set([...panelSource].filter(c => {
  const cp = c.codePointAt(0)
  return cp >= 0xE000 && cp <= 0xF8FF
}))]
assertDeepEqual(strayGlyphs, [], 'every glyph comes from the nf-md block, not the legacy Font Awesome range')

// `state` is an existing Item property; shadowing it hides the base one.
assert(!/property\s+\w+\s+state\s*:/.test(panelSource), 'nothing shadows Item.state')

// ------------------------------------------------------- volumes and extras

const richServer = Model.normalizeServer({
  name: 'web-1', status: 'running',
  server_type: { name: 'cpx21', cores: 3, memory: 4, disk: 80 },
  public_net: { ipv4: { ip: '1.2.3.4' }, ipv6: { ip: '' },
                firewalls: [{ id: 1, status: 'applied' }, { id: 2, status: 'pending' }] },
  protection: { delete: true, rebuild: false },
  rescue_enabled: true,
  iso: { description: 'Ubuntu ISO' },
  placement_group: { name: 'group-a' },
  ingoing_traffic: 12345678,
  image: { os_flavor: 'ubuntu', description: 'Ubuntu 24.04' },
  attached_volumes: [{ name: 'data', size: 100, linux_device: '/dev/sdb', format: 'ext4', status: 'available' }]
}, 'prod')

assertEqual(richServer.volumes.length, 1, 'volumes joined by the bridge come through')
assertEqual(richServer.volumes[0].device, '/dev/sdb', 'a volume keeps its device path')
assertEqual(richServer.firewalls, 2, 'firewall rule sets are counted')
assert(richServer.firewallPending, 'a rule set that is not applied yet is flagged')
assert(richServer.deleteProtected && !richServer.rebuildProtected, 'the two protections are read apart')

// Addresses lead the page and carry their own copy value.
const copyableRows = Model.serverDetails(richServer).filter(row => row.copy)
assertDeepEqual(copyableRows.map(row => row.key), ['IPv4', 'Name', 'SSH'],
  'the addresses, the name and the ssh alias are the copy targets')
assertEqual(Model.serverDetails(richServer)[0].key, 'IPv4', 'the address people want leads the page')
assert(copyableRows.every(row => row.copy !== ''), 'no row claims to be copyable with nothing to copy')

const detailKeysRich = Model.serverDetails(richServer).map(row => row.key)
for (const key of ['Volumes', 'Traffic in', 'Firewall', 'Protected', 'Rescue', 'ISO', 'Placement']) {
  assert(detailKeysRich.indexOf(key) !== -1, 'details show ' + key.toLowerCase())
}
// There is no disk occupancy anywhere in the Cloud API — only provisioned size.
assert(detailKeysRich.indexOf('Disk') !== -1 && !/used|free/i.test(JSON.stringify(Model.serverDetails(richServer))),
  'disk is reported as provisioned size, not as usage the API does not have')

// ---------------------------------------------------------------- metrics

// CPU is the stat tile's job; a row repeating it would be the copy-list
// mistake again.
assertDeepEqual(
  Model.metricRows({ cpu: 4.27, 'network.0.bandwidth.in': 12000, 'disk.0.iops.write': 11 })
    .filter(r => !r.gap).map(r => r.key),
  ['Network', 'Disk I/O'],
  'the rows carry network and disk; the tile carries cpu'
)
assert(Model.metricRows({ 'network.0.bandwidth.in': 1 })[0].gap, 'the live figures are set apart as their own group')
// The rows are on the page before the answer is, so the page has its height
// from the first frame and does not grow under the reader's hand.
assertDeepEqual(Model.metricRows({}, true).map(r => r.value || 'gap'), ['gap', '…', '…'],
  'while the request is out the rows hold their place with an ellipsis')
assertDeepEqual(Model.metricRows({}, false).map(r => r.value || 'gap'), ['gap', '—', '—'],
  'an answer with nothing in it leaves a dash, not a hole')
assert(Model.metricsPending({}, ''), 'nothing arrived and nothing failed is pending')
assert(!Model.metricsPending({}, 'boom'), 'a failure is not pending')
assert(!Model.metricsPending({ cpu: 1 }, ''), 'an answer is not pending')
assert(/visible: root\.detailServer !== null\s*\n\s*width: parent\.width\s*\n\s*spacing: Style\.space\(4\)/.test(panelSource),
  'the CPU tile is on the page whether or not the curve has arrived')

// ---------------------------------------------------------------- sparkline

const curve = [2, 3, 2.5, 8, 14, 6, 3, 2.2, 2.1, 40, 5, 3]
const stats = Model.seriesStats(curve)
assertEqual(stats.count, 12, 'the stats count the samples')
assertEqual(stats.current, 3, 'current is the last sample, not the mean')
assertEqual(stats.peak, 40, 'the peak is the peak')
assertEqual(stats.low, 2, 'and the floor is the floor')
assertEqual(Model.seriesStats([]).count, 0, 'an empty series does not divide by zero')

// Zero baseline with an adaptive top. A floor that never starts at zero turns a
// server idling between 1.1 and 1.4 percent into a mountain range; a top pinned
// to 100 flattens every real machine into a line.
const pts = Model.sparklinePoints(curve, 100, 20)
assertEqual(pts.length, 12, 'one point per sample')
assertEqual(pts[0].x, 0, 'the curve starts at the left edge')
assertEqual(pts[pts.length - 1].x, 100, 'and ends at the right one')
assertEqual(Math.min(...pts.map(p => p.y)), 0, 'the peak reaches the top')
assertEqual(Model.sparklinePoints([0, 0, 5], 100, 20)[0].y, 20, 'zero sits on the baseline')
assertDeepEqual(Model.sparklinePoints([1], 100, 20), [], 'a single sample is not a curve')
assertDeepEqual(Model.sparklinePoints(curve, 0, 20), [], 'nor is one with nowhere to go')

assertEqual(Model.windowLabel(86400), '24h', 'the windows are named')
assertEqual(Model.windowLabel(99), '', 'an unknown window has no name')

// Groups are separated by a gap row, and a gap only earns its place between
// two groups that both have rows.
const rich = Model.serverDetails(richServer)
assert(!rich[0].gap && !rich[rich.length - 1].gap, 'no gap dangles at either end')
assert(!rich.some((row, i) => row.gap && rich[i + 1] && rich[i + 1].gap), 'no two gaps in a row')
assertDeepEqual(
  Model.serverDetails(Model.normalizeServer({ name: 'x' }, 'p')).filter(r => r.gap), [],
  'a server with nothing to say gets no separators at all'
)
assertEqual(Model.parseMetrics('').ok, false, 'an empty metrics answer is an error')
assertEqual(Model.parseMetrics('{"ok":true,"metrics":{"cpu":1}}').metrics.cpu, 1, 'metrics parse through')
assertEqual(Model.parseMetrics('{"ok":true,"metrics":{"cpu":1},"partial":"disk failed"}').partial,
  'disk failed', 'one type failing is a note beside the ones that answered')

// The documented space-separated `type` is rejected by the API with "invalid
// input in field type", so each is asked for on its own.
assert(/for kind in \("cpu", "network", "disk"\)/.test(bridgeSource),
  'the bridge asks for one metric type at a time')
assert(/urllib\.parse\.urlencode/.test(bridgeSource),
  'and encodes the query, since an ISO timestamp ends in a plus')

// ---------------------------------------------------------- storage boxes

// Shaped after a real GET https://api.hetzner.com/v1/storage_boxes response.
const rawBox = {
  id: 645388, username: 'u663294', status: 'active', name: 'storage',
  storage_box_type: { name: 'bx21', description: 'BX21', size: 5497558138880, snapshot_limit: 20 },
  location: { country: 'DE', city: 'Falkenstein', name: 'fsn1' },
  protection: { delete: false },
  access_settings: { webdav_enabled: false, zfs_enabled: false, samba_enabled: false,
                     ssh_enabled: true, reachable_externally: true },
  server: 'u663294.your-storagebox.de',
  system: 'FSN1-BX737',
  stats: { size: 1263095775232, size_data: 1263095775232, size_snapshots: 0 },
  snapshot_plan: null,
  created: '2026-09-04T16:15:26Z'
}

const box = Model.normalizeStorageBox(rawBox, 'wdmr')
assertEqual(box.name, 'storage', 'the box keeps its name')
assertEqual(box.host, 'u663294.your-storagebox.de', 'the host is what you would ssh to')
assertEqual(box.product, 'BX21', 'the type description is the product')
assertEqual(box.location, 'Falkenstein, DE', 'city and country are joined')
// Quota and usage are bytes in this API. Robot reported megabytes; that route is gone.
assertEqual(box.quota, 5497558138880, 'the quota comes from the type size')
assertEqual(box.percent, 23, 'usage is a percentage of the quota')
assertEqual(Model.storageBoxUsageText(box), '1.1 TB of 5 TB · 23 %', 'usage reads in bytes')
assertDeepEqual(box.services, ['SSH'], 'only the enabled services are listed')
assertEqual(Model.storageBoxTone(box), 'live', 'a box with room reads as healthy')

function boxAt(percent, status) {
  return Model.normalizeStorageBox({
    status: status || 'active',
    storage_box_type: { size: 100 },
    stats: { size: percent }
  }, 'p')
}
assertEqual(Model.storageBoxTone(boxAt(80)), 'busy', 'three quarters full warns')
assertEqual(Model.storageBoxTone(boxAt(95)), 'bad', 'ninety percent is urgent')
assertEqual(Model.storageBoxTone(boxAt(5, 'locked')), 'bad', 'a box that is not active is urgent whatever its usage')
assertEqual(Model.normalizeStorageBox({}, 'p').percent, 0, 'a box with no quota does not divide by zero')

const boxDetailKeys = Model.storageBoxDetails(box).map(row => row.key)
for (const key of ['Host', 'User', 'Breakdown', 'Snapshots', 'System', 'Created']) {
  assert(boxDetailKeys.indexOf(key) !== -1, 'box details show ' + key.toLowerCase())
}
// formatBytes renders zero as nothing so empty fields disappear; a zero
// snapshot size is itself the answer.
assert(/0 B snapshots/.test(JSON.stringify(Model.storageBoxDetails(box))), 'no snapshots reads as 0 B, not blank')

// Whether the endpoint is project-scoped or account-wide is not something one
// project can reveal, so the same box may arrive under several tokens.
const twice = [{ storageBoxes: [box] }, { storageBoxes: [box] }]
assertEqual(Model.collectStorageBoxes(twice).length, 1, 'a box seen under two tokens is listed once')
assertEqual(Model.storageBoxError([{ storageBoxesError: 'nope' }]), 'nope', 'a box error surfaces')

// Storage boxes are absent from the old Cloud API but served by the newer one
// to the same project token, so there is no second credential anywhere.
assert(/api\.hetzner\.com\/v1/.test(bridgeSource), 'storage boxes come from the newer API host')
assert(!/robot/i.test(bridgeSource), 'the Robot detour is gone from the bridge')
assert(!/robot/i.test(serviceSource) && !/robot/i.test(panelSource), 'and from the shell side')
assert(/storage_boxes_error/.test(bridgeSource), 'a token that cannot reach them does not fail the whole project')
// Boxes are things you look at, not things you configure, so the section
// belongs in the server list — it had been landing behind the gear.
assert(panelSource.indexOf('// ------------------------------------------------- storage boxes')
  < panelSource.indexOf('visible: root.view === "settings"'),
  'the storage box section sits in the servers view, not the settings one')

// ------------------------------------------------------------ one list

// Servers and boxes are one list under one cursor: a project's servers, then
// its boxes, then the next project. Row indices have to agree with that.
const mixed = [
  { label: 'a', ok: true, servers: [Model.normalizeServer({ id: 1, name: 'web' }, 'a')],
    storageBoxes: [Model.normalizeStorageBox({ id: 1, name: 'store', server: 'u1.your-storagebox.de', username: 'u1' }, 'a')] },
  { label: 'b', ok: true, servers: [Model.normalizeServer({ id: 2, name: 'api' }, 'b')], storageBoxes: [] }
]
const mixedGroups = Model.buildGroups(mixed, '')
assertDeepEqual(mixedGroups.groups.map(g => g.offset), [0, 2], 'a box takes the index after its project\'s servers')
assertDeepEqual(Model.flatRows(mixedGroups).map(r => r.rowKind), ['server', 'box', 'server'],
  'flatRows walks servers, then boxes, per project')
assertEqual(Model.flatServers(mixedGroups).length, 2, 'flatServers still counts servers only')
assertEqual(Model.rowKey(mixed[0].servers[0]), '1', 'a server is keyed by its id')
assertEqual(Model.rowKey(mixed[0].storageBoxes[0]), 'box:1', 'a box with the same number is kept apart')

const mixedBox = mixed[0].storageBoxes[0]
assertDeepEqual(Model.copyOptions(mixedBox, 'ignored').map(o => o.kind), ['host', 'name', 'user', 'ssh'],
  'a box offers host, name, user and the ssh target')
assertEqual(Model.copyValue(mixedBox, 'ipv4', ''), 'u1.your-storagebox.de', 'c copies the address you connect to, for a box its host')
assertEqual(Model.copyValue(mixedBox, 'ssh', ''), 'u1@u1.your-storagebox.de', 's copies what goes after ssh')
assertEqual(Model.copyValue(mixedBox, 'private', ''), '', 'a box has no private address to copy')

// The panel side of the same contract.
assert(/Model\.flatRows\(groups\)/.test(panelSource), 'the cursor walks flatRows, not servers alone')
assert(/component StorageBoxRow: CursorSurface \{[\s\S]*?hasCursor: root\.cursorActive/.test(panelSource),
  'a storage box row takes the cursor')
assert(/groups\[i\]\.offset \+ groups\[i\]\.servers\.length \+ rowIndex/.test(panelSource),
  'and computes its index after the servers of its project')
assert(/root\.registerServerRow\(root\.rowKey\(box\), boxRow\)/.test(panelSource), 'and registers itself for Enter')
assert(/id: boxCopyMenu/.test(panelSource) && /id: copyMenu/.test(panelSource), 'both kinds of row share the one copy menu')
assert((panelSource.match(/component CopyMenu: Popup/g) || []).length === 1
  && (panelSource.match(/^\s*Popup \{/gm) || []).length === 0, 'the menu is defined once, not per row kind')

// ---------------------------------------------------------------- os marks

function imageServer(flavor, name) {
  return Model.normalizeServer({ image: { os_flavor: flavor, name: name, description: name } }, 'p')
}
assertEqual(Model.osKey(imageServer('ubuntu', 'ubuntu-24.04')), 'ubuntu', 'os_flavor picks the distro')
assertEqual(Model.osKey(imageServer('rocky', 'rocky-9')), 'rocky', 'rocky is its own mark')
assertEqual(Model.osKey(imageServer('alma', 'alma-9')), 'alma', 'alma is its own mark')
// Snapshots and custom images report unknown, so the name has to carry it.
assertEqual(Model.osKey(imageServer('unknown', 'archlinux-x86')), 'arch', 'an unknown flavour falls back to the image name')
assertEqual(Model.osKey(imageServer('unknown', 'opensuse-leap')), 'opensuse', 'suse variants resolve')
assertEqual(Model.osKey(imageServer('unknown', 'my-snapshot')), '', 'an unrecognisable image resolves to nothing')
assert(Model.osGlyph(imageServer('unknown', 'my-snapshot')) !== '', 'an unrecognised image still gets a glyph, not a blank column')
assert(Model.osGlyph(null) !== '', 'a missing server still gets a glyph')
assertEqual(Model.osLabel(imageServer('ubuntu', 'Ubuntu 24.04')), 'Ubuntu 24.04', 'the label prefers the image name')

// Distro marks come from Nerd Fonts' font-logos block, which lives in the
// private use area below U+F0000 unlike the nf-md glyphs used everywhere else.
// There is no nf-md equivalent for most distributions, so this is deliberate —
// but it should stay confined to that one block and to this one file.
const modelSource = fs.readFileSync(path.join(root, 'Model.js'), 'utf8')
const modelGlyphs = [...new Set([...modelSource].filter(c => c.codePointAt(0) >= 0xE000))]
assert(modelGlyphs.length > 0 && modelGlyphs.every(c => {
  const cp = c.codePointAt(0)
  // font-logos for the distributions.
  return (cp >= 0xF300 && cp <= 0xF32F) || cp >= 0xF0000
}), 'every glyph is font-logos or nf-md')

// Rows start with their text. The state is carried by the status word beside
// the name — absent for a running machine, in the tone's colour otherwise,
// breathing through a transition — not by a mark in a column of its own.
assert(!/stateGlyph/.test(panelSource) && !/stateGlyph/.test(modelSource), 'no row leads with a state mark')
assert(/id: statusWord[\s\S]*?color: root\.toneColor\(/.test(panelSource), 'the status word carries the tone')
// The state is a small disc before the name: filled running, hollow off,
// breathing through a transition, with the word in a tooltip.
assert(/component StateDot: Item \{[\s\S]*?readonly property bool filled: tone === "live" \|\| tone === "bad"/.test(panelSource),
  'the dot is filled for running and urgent, hollow otherwise')
assert(/color: stateDot\.filled \? stateDot\.toneColor : "transparent"\s*\n\s*border\.color: stateDot\.toneColor/.test(panelSource),
  'a hollow dot keeps its outline in the tone colour')
assert(/SequentialAnimation on opacity \{\s*running: stateDot\.tone === "busy"/.test(panelSource), 'a transition breathes')
assert(/PanelToolTip \{\s*visible: dotHover\.hovered && stateDot\.label !== ""/.test(panelSource), 'and the word is in the tooltip')
assert(/component ServerRow[\s\S]*?StateDot \{\s*tone: serverRow\.server/.test(panelSource), 'a server row leads with its dot')
assert(/component StorageBoxRow[\s\S]*?StateDot \{\s*tone: boxRow\.boxTone/.test(panelSource), 'and so does a box row')
assertEqual(Model.intervalLabel(60), '1 min', 'a minute is labelled as one')
assertEqual(Model.intervalLabel(900), '15 min', 'and so is a quarter hour')
assertEqual(Model.intervalLabel(3600), '1 h', 'an hour is an hour')
assertEqual(Model.intervalLabel(90), '90 s', 'odd values fall back to seconds')

// The distro mark sits at the trailing edge, where what stands to its right
// fixes its x on every row, and a spacer keeps it out of the button cluster so
// it does not read as pressable. Copy and chevron are one tight pair.
const iOs = panelSource.indexOf('text: Model.osGlyph(serverRow.server)')
const iDetail = panelSource.indexOf('id: detailButton')
const iCopy = panelSource.indexOf('id: copyButton')
assert(iOs < iCopy, 'the distro mark trails the text, before the buttons')
assert(/RowLayout \{\s*spacing: Style\.space\(2\)\s*Layout\.alignment: Qt\.AlignVCenter\s*\n\s*PanelActionButton \{\s*id: copyButton/.test(panelSource),
  'copy and chevron sit in a cluster of their own, set tight')
// The chevron changes the row itself, so it takes the outer edge the way a
// disclosure indicator does anywhere else; copy acts on the content and stays
// nearer to it. It also lines up with the storage box rows, which have a
// chevron and no copy button.
assert(iCopy < iDetail, 'the chevron sits outermost, after the copy button')
assert(/Layout\.preferredWidth: Style\.space\(4\)/.test(panelSource), 'a spacer separates the distro mark from the buttons')

// ---------------------------------------------------------------- accounts

// A label groups one or more Hetzner projects; each key names one token in the
// keyring, and their servers appear together under the label.
assertDeepEqual(
  Model.normalizeAccounts({ accounts: [
    { label: 'production', keys: ['production', 'production-2'] },
    { label: 'staging', prefix: 'stg' }] }),
  [{ label: 'production', keys: ['production', 'production-2'] },
   { label: 'staging', keys: ['staging'] }],
  'accounts are label and keys — a prefix left over from an older install is dropped'
)
// Installs that predate either change still have to find their tokens.
assertDeepEqual(
  Model.normalizeAccounts({ accountLabels: ['production'], sshPrefixes: { production: 'prod' } }),
  [{ label: 'production', keys: ['production'] }],
  'the old accountLabels shape is folded in'
)
assertDeepEqual(
  Model.normalizeAccounts({ accounts: [{ label: 'a' }] })[0].keys, ['a'],
  'a label with no keys recorded keeps its token under the label itself'
)
assertDeepEqual(Model.normalizeAccounts({}), [], 'no settings means no accounts')
assertDeepEqual(
  Model.normalizeAccounts({ accounts: [{ label: 'a' }, { label: '  a  ' }, { label: '' }] }).length,
  1, 'duplicate and empty labels are dropped')

let acc = Model.normalizeAccounts({ accountLabels: ['wdmr'] })
assertEqual(Model.nextKey(acc, 'wdmr'), 'wdmr-2', 'a second token under a label gets its own key')
acc = Model.addAccount(acc, 'wdmr')
acc = Model.addAccount(acc, 'wdmr')
assertDeepEqual(acc[0].keys, ['wdmr', 'wdmr-2', 'wdmr-3'], 'keys accumulate under one label')
assertDeepEqual(Model.accountKeys(Model.addAccount(acc, 'privat')),
  ['wdmr', 'wdmr-2', 'wdmr-3', 'privat'], 'every key is offered to the bridge')
assertEqual(Model.labelForKey(acc, 'wdmr-3'), 'wdmr', 'a key resolves back to the label that owns it')
assertEqual(Model.labelForKey(acc, 'stranger'), 'stranger', 'an unknown key stands for itself')
// Removing a label takes all of its tokens with it — a leftover key would be
// silently inherited by a label of the same name added later.
assertDeepEqual(Model.removeAccount(acc, 'wdmr'), [], 'removing a label removes all of its keys')

// One name. An ssh Host pattern will not take spaces or capitals, so the alias
// is derived from the label rather than asked for a second time and kept in
// step by hand.
assertEqual(Model.sshAliasFor('wdmr'), 'wdmr', 'a plain label is already an alias')
assertEqual(Model.sshAliasFor('W11K'), 'w11k', 'capitals come down')
assertEqual(Model.sshAliasFor('WDMR Produktion'), 'wdmr-produktion', 'spaces become dashes')
assertEqual(Model.sshAliasFor('kunde/alt'), 'kunde-alt', 'a slash would split the Host pattern')
assertEqual(Model.sshAliasFor('Räume'), 'raeume', 'German letters fold rather than vanish')
assertEqual(Model.sshAliasFor('Zürich'), 'zuerich', 'and so do the rest of them')
assertEqual(Model.sshAliasFor('  --x--  '), 'x', 'padding and stray dashes come off')
assertEqual(Model.sshAliasFor(''), 'project', 'something unusable still yields a usable alias')

const prefixed = Model.addAccount([], 'WDMR Prod')
assertDeepEqual(prefixed, [{ label: 'WDMR Prod', keys: ['WDMR Prod'] }],
  'an account is a label and its keys, nothing else')

// Several tokens under one label pool their servers and boxes, duplicates go,
// and one bad token is marked against the label without hiding the rest.
const merged = Model.parseBridge(JSON.stringify({ ok: true, projects: [
  { label: 'wdmr', ok: true, status: 200, servers: [{ id: 1, name: 'web-1' }], storage_boxes: [{ id: 9 }] },
  { label: 'wdmr-2', ok: true, status: 200, servers: [{ id: 2, name: 'api' }, { id: 1, name: 'web-1' }], storage_boxes: [{ id: 9 }] },
  { label: 'privat', ok: false, status: 401, error: 'invalid', servers: [] }
] }), Model.normalizeAccounts({ accounts: [
  { label: 'wdmr', keys: ['wdmr', 'wdmr-2'] }, { label: 'privat', keys: ['privat'] }] })).projects

assertEqual(merged.length, 2, 'two labels, whatever the number of tokens')
assertDeepEqual(merged[0].servers.map(s => s.name), ['api', 'web-1'], 'servers pool under the label')
assertEqual(merged[0].storageBoxes.length, 1, 'a box reachable under two tokens is listed once')
assertEqual(merged[0].servers[0].project, 'wdmr', 'servers are stamped with the label, not the key')
assertEqual(merged[1].ok, false, 'a failing token marks its label')
assertEqual(merged[1].status, 401, 'and keeps the status for the panel to explain')

// ---------------------------------------------------------------- ssh sync

const okProjects = [
  { label: 'production', ok: true, servers: [
    { name: 'web-1', ipv4: '203.0.113.10' },
    { name: 'db-1', ipv4: '' }
  ] },
  { label: 'staging', ok: true, servers: [{ name: 'api', ipv4: '198.51.100.5' }] }
]
const accounts = [{ label: 'production', prefix: '' }, { label: 'staging', prefix: 'stg' }]

assertDeepEqual(
  Model.sshHosts(okProjects),
  [{ alias: 'production/web-1', ip: '203.0.113.10' }, { alias: 'staging/api', ip: '198.51.100.5' }],
  'ssh hosts take the alias from the label and skip servers with no IPv4'
)
// The copy menu and the synced config must name the same host.
assertEqual(
  Model.copyValue(Model.normalizeServer({ name: 'api' }, 'WDMR Prod'), 'ssh', Model.sshAliasFor('WDMR Prod')),
  'wdmr-prod/api',
  'the copy menu offers the alias the ssh config actually defines'
)
assertDeepEqual(
  Model.sshHosts([{ label: 'a', ok: true, servers: [{ name: 'x', ipv4: '1.1.1.1' }] },
                  { label: 'a', ok: true, servers: [{ name: 'x', ipv4: '2.2.2.2' }] }]),
  [{ alias: 'a/x', ip: '1.1.1.1' }],
  'a duplicate alias is written once, not twice'
)

// Losing a project to a 401 or a dead network empties its server list. Syncing
// that would silently delete those hosts from ~/.ssh/config.
assert(Model.canSyncSsh(okProjects), 'a complete picture is safe to sync')
assert(!Model.canSyncSsh(okProjects.concat([{ label: 'broken', ok: false, servers: [] }])),
  'a failed project blocks the sync')
assert(!Model.canSyncSsh([]), 'nothing loaded is not something to sync')

assertEqual(Model.syncStatusText(false, null), 'Off', 'the status says so when sync is off')
assertEqual(Model.syncStatusText(true, null), 'Waiting for the next refresh', 'the status admits it has not run')
assertEqual(Model.syncStatusText(true, { at: '11:42', hosts: 3, error: '' }), '3 hosts written \u00b7 11:42',
  'the status reports host count and time')
assertEqual(Model.syncStatusText(true, { at: '11:42', hosts: 0, error: 'boom' }), 'boom',
  'a sync error replaces the status')

// ---------------------------------------------------------------- manifest

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
const schema = {}
for (const field of manifest.barWidget.schema) schema[field.key] = field

// Writing to ~/.ssh/config is never something to opt out of by accident.
assertEqual(schema.syncSshConfig.defaultValue, false, 'the ssh sync setting defaults to off')
assertEqual(manifest.barWidget.defaults.syncSshConfig, false, 'the ssh sync default is off in defaults too')
assertEqual(schema.sshUser.defaultValue, 'root', 'the ssh user defaults to root')
assertEqual(schema.sshKey.defaultValue, '', 'no IdentityFile is written unless asked for — ssh finds the usual keys itself')
assertEqual(manifest.barWidget.defaults.sshKey, '', 'in defaults too')
assert(/setting\("sshKey", ""\)/.test(serviceSource), 'and the service agrees')
assertEqual(manifest.id, 'io.github.ndrsgg.hcloud', 'the plugin id is stable')
assertEqual(schema.idleIntervalSec.defaultValue, 600, 'the idle interval defaults to ten minutes')
assertEqual(schema.refreshIntervalSec.defaultValue, 300, 'the refresh interval defaults to five minutes')
assertEqual(manifest.barWidget.defaults.refreshIntervalSec, 300, 'in defaults too')
assert(/intSetting\("refreshIntervalSec", 300, 15, 3600\)/.test(serviceSource), 'and the service agrees')
assertEqual(manifest.barWidget.defaults.demo, false, 'demo data is off unless asked for')
assert(!('demo' in schema), 'and is not offered in the settings form — it is a maintainer switch, set with omarchy bar set')

// Demo data: the bridge answers from the file and touches nothing real.
const fleet = JSON.parse(fs.readFileSync(path.join(root, 'demo', 'fleet.json'), 'utf8'))
assertDeepEqual(Object.keys(fleet.projects).sort(), ['production', 'staging'], 'the demo fleet has the two labels the panel expects')
assertDeepEqual(Model.demoAccounts().map(a => a.label), ['production', 'staging'], 'and the panel expects those')
const demoServers = Object.values(fleet.projects).flatMap(p => p.servers)
assert(demoServers.every(s => /^(203\.0\.113|198\.51\.100)\./.test(s.public_net.ipv4.ip)), 'demo addresses come from the documentation ranges')
assert(demoServers.some(s => s.status === 'off') && demoServers.some(s => s.status === 'starting') && demoServers.some(s => s.locked),
  'the demo fleet shows every state the panel paints')
for (const cmd of ['command_store', 'command_remove']) {
  assert(new RegExp('def ' + cmd + '\\([^)]*\\):\\s*\\n\\s*if DEMO:\\s*\\n\\s*return fail\\(').test(bridgeSource), cmd + ' refuses in demo mode before doing anything')
}
assert(/if \(demo\) args\.push\("--demo"\)/.test(serviceSource), 'the service passes the flag on every bridge call')
// `omarchy bar set` writes a string unless told --json; "true" must switch as well as true.
assert(/readonly property bool demo: boolSetting\("demo", false\)/.test(serviceSource)
  && /readonly property bool syncSshConfig: boolSetting\("syncSshConfig", false\)/.test(serviceSource)
  && /String\(value\)\.toLowerCase\(\) === "true"/.test(serviceSource),
  'boolean settings accept the string the CLI writes')
assert(/readonly property var accounts: demo \? Model\.demoAccounts\(\)/.test(serviceSource), 'and shows the demo labels')
assert(/onDemoChanged: \{\s*projects = \[\][\s\S]*?lastServersRaw = ""[\s\S]*?delayedRefresh\.restart\(\)/.test(serviceSource),
  'flipping the switch drops what is on screen and fetches again at once')
assertEqual(manifest.barWidget.defaults.idleIntervalSec, 600, 'in defaults too')
assertDeepEqual(manifest.barWidget.defaults.accounts, [], 'the account list starts empty')
assert(!('sshPrefixes' in manifest.barWidget.defaults), 'the parallel prefix map is gone')

// ---------------------------------------------------------------- model hygiene

// A function defined twice is a trap: the second definition wins, so an edit to
// the first silently does nothing. This is how 200 duplicated lines shipped.
const declaredFunctions = [...modelSource.matchAll(/^function (\w+)/gm)].map(m => m[1])
assertDeepEqual(declaredFunctions.filter((name, i) => declaredFunctions.indexOf(name) !== i), [],
  'every function in Model.js is defined once')
const declaredTables = [...modelSource.matchAll(/^var (\w+)/gm)].map(m => m[1])
assertDeepEqual(declaredTables.filter((name, i) => declaredTables.indexOf(name) !== i), [],
  'every table in Model.js is defined once')

// ---------------------------------------------------------------- sync writer

// The file the bridge writes is read by ssh. Every field is checked before a
// byte goes out, and the check comes before any keyring access so it can be
// exercised without one.
assert(/ALIAS_RE = re\.compile/.test(bridgeSource), 'the bridge has a rule for what a Host may be called')
assert(/ipaddress\.ip_address/.test(bridgeSource), 'and insists that a HostName is an address')
assert(/os\.path\.realpath/.test(bridgeSource), 'a symlinked ssh config is followed, not replaced')
assert(/isdigit\(\)/.test(bridgeSource.slice(bridgeSource.indexOf('def command_metrics'))),
  'a server id is a number before it goes into a URL')
assert(/except Exception as error:[^\n]*\n\s*return fail\(/.test(bridgeSource.slice(bridgeSource.indexOf('def main'))),
  'no failure in the bridge leaves as a traceback')

assert(/# --- hcloud-sync START ---/.test(bridgeSource), 'the bridge uses the documented start marker')
assert(/# --- hcloud-sync END ---/.test(bridgeSource), 'the bridge uses the documented end marker')
assert(/S_IRUSR \| S_IWUSR|stat\.S_IRUSR/.test(bridgeSource), 'the bridge writes the config 0600')
assert(/os\.replace/.test(bridgeSource), 'the bridge writes atomically')
assert(/if updated == existing/.test(bridgeSource), 'an unchanged config is left alone')
assert(/unterminated hcloud-sync block/.test(bridgeSource), 'a half-deleted block is refused rather than spliced')

// Settings live in their own view behind the gear, so the server list stays a
// server list. A fresh install with no token cannot leave that view.
assert(/property string view: "servers"/.test(panelSource), 'the panel has a servers/settings view switch')
assert(/if \(view === "settings" && !hasLabels\) return/.test(panelSource),
  'the settings view cannot be left before a token exists')
assert(/root\.view === "settings" && root\.hasLabels\) root\.toggleView\(\)/.test(panelSource),
  'escape backs out of settings before closing the panel')
assert(/view !== "servers"/.test(panelSource), 'the search field belongs to the servers view only')
assert(/searchRevealed = true/.test(panelSource), 'the search shortcut reaches the field below the row threshold')
assert(/Model\.serverDetails\(detailServer\)/.test(panelSource), 'the detail page renders what serverDetails computes')
// The page used to end in a list of copy targets that repeated three of the
// rows above it verbatim, five rows tall. The value itself is the target now,
// the way the network panel does it.
assert(!/text: "COPY"/.test(panelSource), 'no separate list of copy targets')
// The hero is the panel's identity, not the current selection: opening a
// server must not take the fleet summary off the top of the panel.
assert(/title: "Hetzner Cloud"/.test(panelSource), 'the header says the same thing on every view')
assert(!/title: root\.detailTitle/.test(panelSource), 'and does not become whatever row is open')
assert(/text: root\.detailTitle/.test(panelSource), 'the open row names itself below the header instead')
assert(/enabled: String\(modelData\.copy \|\| ""\) !== ""/.test(panelSource),
  'a detail row is clickable exactly when it has something to copy')
assert(/text: "Copy to clipboard"/.test(panelSource), 'and says so on hover')
assert(/horizontalAlignment: Text\.AlignRight/.test(panelSource),
  'detail values are right aligned, so the page has two edges and not a ragged column')
assert(/visible: modelData\.gap !== true/.test(panelSource), 'a gap row is space, not an empty row')
// A metrics call that fails used to leave the page looking as if the server
// simply had no live figures.
assert(/hcloud\.metricsError !== ""/.test(panelSource), 'a failed metrics call says so on the page')

// One series, so no legend and no palette to validate — the colour comes from
// the theme at runtime. What the mark spec does pin down is the line itself.
assert(/PathPolyline \{ path: root\.sparkPath \}/.test(panelSource), 'the curve is a polyline over the samples')
assert(/capStyle: ShapePath\.RoundCap/.test(panelSource) && /joinStyle: ShapePath\.RoundJoin/.test(panelSource),
  'drawn as a 2px line with round joins and caps, per the mark spec')
assert(/strokeColor: root\.accent/.test(panelSource), 'in a theme colour, like everything else here')
// Comments describing the absence would match; read the code, not the prose.
assert(!/gridline|axisLabel|Legend/i.test(panelSource.replace(/\/\/[^\n]*/g, '')),
  'no grid, no axes, no legend for a single series')
assert(/peak " \+ Model\.formatPercent/.test(panelSource),
  'the peak is printed, so an adaptive top never leaves the scale implicit')
assert(/visible: root\.view === "detail"/.test(panelSource),
  'only the detail page, which has no rule of its own, gets one under the header')
// A label can hold several tokens, and the form says which of the two things
// it is about to do before it does it.
assert(/beginAddToken/.test(panelSource), 'a token can be added under an existing label')
assert(/Adds a " \+ \(existing\.keys\.length === 1 \? "second" : "further"\)/.test(panelSource),
  'the form distinguishes a new heading from a further token')
assert(/tokenCount > 1/.test(panelSource), 'a label with several tokens says so')
assert(/enabled: !hcloud\.busy && labelField\.text\.trim\(\) !== "" && tokenField\.text !== ""/.test(panelSource),
  'saving is off until there is something to save')

assert(/property string detailId/.test(panelSource), 'the detail view knows which row it is showing')
// A page rather than an expander: nothing in the list moves. network/Panel.qml
// keeps its rows mounted for exactly that reason, and says so in a comment.
assert(!/expandedId/.test(panelSource), 'no row expands in place any more')
assert(/dx > 0 && view === "servers"/.test(panelSource), 'right walks into a row')
assert(/dx < 0 && view === "detail"/.test(panelSource), 'left backs out of it')

// A filled disc with the H knocked out of it, tinted to the theme. Rendered
// from SVG through Image, not rebuilt with QtQuick.Shapes: the shape renderer
// antialiases along extruded edge geometry and loses a two pixel counter at
// bar size, which is what three earlier attempts foundered on.
const iconSource = fs.readFileSync(path.join(root, 'HetznerIcon.qml'), 'utf8')
const iconCode = iconSource.replace(/\/\/[^\n]*/g, '')
const symbolicSvg = fs.readFileSync(path.join(root, 'assets', 'hetzner-symbolic.svg'), 'utf8')

assert(/fill-rule="evenodd"/.test(symbolicSvg), 'the H is knocked out of the disc, not drawn over it')
assert(/fill="#ffffff"/.test(symbolicSvg), 'the symbolic mark is white, which colorization maps exactly onto the tint')
assert((symbolicSvg.match(/<path/g) || []).length === 1, 'disc and H are one path, so the even-odd hole holds')
assert(!fs.existsSync(path.join(root, 'assets', 'hetzner-h.svg')) && !/brand/.test(iconCode), 'no brand artwork ships; the mark is the symbolic one, tinted')

assert(!/ShapePath|QtQuick\.Shapes/.test(iconCode), 'the mark is not rebuilt with the shape renderer')
assert(/colorization: 1\.0/.test(iconCode) && /colorizationColor: root\.color/.test(iconCode),
  'the symbolic mark is tinted to the caller colour')
assert(/sourceSize\.width:.*iconSize \* 4/.test(iconCode), 'the mark is rasterised above its drawn size')
assert(/status !== Image\.Ready/.test(iconCode), 'a missing asset still leaves something clickable')
// A layer's texture defaults to logical pixels and is stretched up on a scaled
// display, which softened the disc edge.
assert(/layer\.textureSize/.test(iconCode), 'the tint layer is given texels for a scaled display')
// Edge to edge the disc outweighs the glyphs beside it in the bar.
assert(/viewBox="0 0 400 400"/.test(symbolicSvg), 'the symbolic mark has a square box')
// 81% of the box, matching the ink the bar's glyph icons draw in theirs.
assert(/A 162 162 /.test(symbolicSvg), 'the disc is inset inside that box rather than filling it')

// The scrollbar had been painting on top of the copy buttons.
assert(/panelFlick\.width - panelScroll\.implicitWidth/.test(panelSource),
  'the scrollbar gets its own lane instead of overlapping the rows')

// The panel must not poll a remote API at full rate with nobody watching.
assert(/effectiveIntervalSec/.test(serviceSource), 'the refresh timer backs off when the panel is closed')
assert(/Math\.max\(refreshIntervalSec, idleIntervalSec\)/.test(serviceSource),
  'the idle interval never polls faster than the configured one')

// The shell builds one instance per monitor. Only one of them may poll while
// the panel is closed, and it has to hand what it fetched to the others.
assert(/bar\.moduleWidgets\(moduleName\)/.test(panelSource), 'the panel finds its peers through the shell')
assert(/if \(!panelOpen && !isPrimary\(\)\)/.test(serviceSource), 'a closed panel on a secondary screen does not poll')
assert(/if \(isPrimary\(\)\) maybeSyncSsh\(\)/.test(serviceSource), 'only the primary writes the ssh config')
assert(/onServersLoaded: function\(raw\) \{ root\.shareServers\(raw\) \}/.test(panelSource),
  'a fetched result is pushed to the other screens')
assert(/function applyShared/.test(serviceSource) && !/applyShared[\s\S]*serversLoaded\(/.test(
  serviceSource.slice(serviceSource.indexOf('function applyShared'), serviceSource.indexOf('function maybeSyncSsh'))),
  'a shared result is not pushed on again, or two screens would ping-pong')

// A refresh from the bar icon or over IPC lands on one fixed instance, which
// with the panel shut may not be the one that polls.
assert(/function refresh\(\): string \{ root\.requestRefresh\(\)/.test(panelSource), 'an IPC refresh is routed to the polling instance')
assert(/Qt\.MiddleButton\) root\.requestRefresh\(\)/.test(panelSource), 'and so is a right-click on the icon')

// The watchdog measures the process that is running, not the one before it.
assert(/pollWatchdog\.restart\(\)/.test(serviceSource), 'the watchdog is armed on every launch')
assert(/onExited: function\(exitCode\) \{\s*pollWatchdog\.stop\(\)/.test(serviceSource),
  'and disarmed the moment the bridge exits')
assert(/watchdogMs: 60000/.test(serviceSource), 'its budget covers a retried slow answer')
assert(/ThreadPoolExecutor/.test(bridgeSource), 'projects are fetched side by side, so one slow one does not hold the rest')
assert(/done = in_parallel\(\{\s*"servers":[\s\S]*?"volumes":[\s\S]*?"storage_boxes":/.test(bridgeSource),
  'and so are the three requests a project is made of')
assert(/BOX_TIMEOUT = 6\s*\nBOX_ATTEMPTS = 1/.test(bridgeSource), 'storage boxes get one short try and never hold the list')
assert(/"timings_ms": timings/.test(bridgeSource), 'the bridge reports how long each request took')
assert(/if volumes_error is not None:\s*\n\s*volumes = \[\]/.test(bridgeSource), 'a failed volumes call costs the volumes, not the list')
assert(/ATTEMPTS = 2/.test(bridgeSource) && /is_timeout\(error\) and attempt \+ 1 < attempts/.test(bridgeSource),
  'a timed-out request is retried once before it counts')
assert(/did not answer in time/.test(bridgeSource), 'a timeout is named as one, not as a socket message')
assert(/def command_uninstall/.test(bridgeSource) && /if command == "uninstall":/.test(bridgeSource), 'the bridge can take back everything it left outside its directory')
assert(/if window not in WINDOWS:\s*\n\s*window = 3600/.test(bridgeSource), 'a metrics window is one of the three the panel offers')
assertEqual(manifest.barWidget.category, 'Developer Tools', 'the category is one the plugin directory knows')

// A project that failed this round keeps what it showed last round.
const lastGood = [{ label: 'a', ok: true, servers: [Model.normalizeServer({ id: 1, name: 'web' }, 'a')], storageBoxes: [] }]
const thisRound = [{ label: 'a', ok: false, status: 0, error: 'Hetzner did not answer', servers: [], storageBoxes: [] }]
const retained = Model.retainPrevious(thisRound, lastGood)
assertEqual(retained[0].servers.length, 1, 'a failed project keeps its last list')
assert(retained[0].ok === false && retained[0].stale === true, 'and is still marked as failed, and as stale')
assert(!Model.canSyncSsh(retained), 'stale data is never written to the ssh config')
assertEqual(Model.buildGroups(retained, '').groups[0].stale, true, 'the group knows it is showing old rows')
assertEqual(Model.retainPrevious(thisRound, []).length, 1, 'with nothing to fall back on the failure stands as it is')
assertEqual(Model.retainPrevious(thisRound, [])[0].servers.length, 0, 'and its list stays empty')
assertEqual(Model.retainPrevious(lastGood, thisRound)[0].servers.length, 1, 'a project that loaded is never overwritten by an older failure')
assert(/lastUpdated = Qt\.formatDateTime/.test(serviceSource), 'the service remembers when the list was fetched')
assert(/"Refresh now · data from " \+ header\.updatedAt/.test(panelSource), 'and the refresh button says so')
assert(/did not answer within/.test(serviceSource), 'a timeout is reported as one, not as a crash')

// A refresh by hand says so when it lands, and is seen while it is out.
assert(/function refreshManually/.test(serviceSource), 'a manual refresh is its own entry point')
assert(/if \(key === "r"\) hcloud\.refreshManually\(\)/.test(panelSource), 'r uses it')
assert(/function refreshNow\(\) \{ hcloud\.refreshManually\(\) \}/.test(panelSource), 'and so does the header button')
assert(/flash\("Refreshed · " \+ Model\.plural\(count, "server"\)\)/.test(serviceSource), 'it reports what came back')
assert(/RotationAnimation on rotation \{[\s\S]*?running: header\.refreshing/.test(panelSource),
  'the refresh glyph turns while the bridge is out')

// The open row is asked again every minute, whatever the refresh interval.
assert(/id: metricsTimer[\s\S]*?interval: 60000[\s\S]*?running: root\.panelOpen && root\.metricsServerId !== ""/.test(serviceSource),
  'metrics have a one-minute timer of their own while a row is open')

// Opening the panel is not a reason to hit the API when a poll is already
// running in the background and what is on screen is younger than the interval.
assert(/onOpenedChanged: \{[\s\S]*?hcloud\.refreshIfStale\(\)/.test(panelSource), 'opening the panel fetches only when stale')
assert(!/onOpenedChanged: \{[\s\S]*?\n\s*hcloud\.refresh\(\)[\s\S]*?Qt\.callLater\(function\(\) \{ keyCatcher/.test(panelSource),
  'and never unconditionally')
assert(/Date\.now\(\) - lastFetchMs >= refreshIntervalSec \* 1000/.test(serviceSource), 'stale means older than the refresh interval')
assert(/intSetting\("idleIntervalSec", 600, 60, 86400\)/.test(serviceSource), 'the idle interval is a setting')
assert(/persistSetting\("refreshIntervalSec", modelData\)/.test(panelSource), 'the refresh interval can be set from the panel')

// Metrics are for the row being looked at; a shut panel has none.
assert(/if \(!opened\) \{\s*(\/\/[^\n]*\n\s*)*hcloud\.clearMetrics\(\)/.test(panelSource),
  'closing the panel stops the metrics polling')

// A search hides the projects it emptied — in the panel, not just in the model.
assert(/visible: !group\.hidden/.test(panelSource), 'an emptied project group steps aside during a search')

// A label rides on secret-tool's command line as a positional argument.
assert(/name\.charAt\(0\) === "-"/.test(serviceSource), 'a label may not start with a dash')

console.log((failures === 0 ? 'ok' : 'FAILED') + ' — ' + (checks - failures) + '/' + checks + ' checks passed')
process.exit(failures === 0 ? 0 : 1)
