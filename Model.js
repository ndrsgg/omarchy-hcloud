// Pure helpers for the Hetzner Cloud panel. No QML types in here so the whole
// file also runs under node — see test/model.test.js.

function str(value) {
  return value === undefined || value === null ? "" : String(value)
}

function num(value) {
  var n = Number(value)
  return isFinite(n) ? n : 0
}

// Hetzner's server states, grouped into the four the panel paints. The names
// say what a state *is*, not what colour it gets — an earlier set called them
// after their own appearance, which made it easy to miss that "running" was
// being painted in the same foreground as the text beside it.
function statusTone(status) {
  var value = str(status).toLowerCase()
  if (value === "running") return "live"
  if (value === "off") return "off"
  if (value === "starting" || value === "stopping" || value === "initializing"
    || value === "migrating" || value === "rebuilding" || value === "deleting") return "busy"
  return "bad"
}

function isTransitional(status) {
  return statusTone(status) === "busy"
}

function formatBytes(bytes) {
  var n = num(bytes)
  if (n <= 0) return ""
  var units = ["B", "KB", "MB", "GB", "TB", "PB"]
  var index = 0
  while (n >= 1024 && index < units.length - 1) {
    n = n / 1024
    index++
  }
  var rounded = n >= 100 || index === 0 ? Math.round(n) : Math.round(n * 10) / 10
  return String(rounded) + " " + units[index]
}

// formatBytes() renders zero as nothing, so empty fields disappear. Where a
// zero is itself the answer — no snapshots — say so.
function bytesOrZero(bytes) {
  var text = formatBytes(bytes)
  return text === "" ? "0 B" : text
}

function formatMemory(gb) {
  var n = num(gb)
  if (n <= 0) return ""
  var rounded = n === Math.floor(n) ? n : Math.round(n * 10) / 10
  return String(rounded) + " GB"
}

// "2026-09-09T08:41:12+00:00" -> "2026-09-09". Anything unparseable passes
// through untouched rather than showing "Invalid Date" in the panel.
function formatCreated(created) {
  var value = str(created)
  var match = value.match(/^(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : value
}

function locationText(raw) {
  var datacenter = (raw && raw.datacenter) || {}
  var location = datacenter.location || {}
  var city = str(location.city)
  var country = str(location.country)
  if (city !== "" && country !== "") return city + ", " + country
  return city || country || str(datacenter.name)
}

function privateIps(raw) {
  var result = []
  var nets = (raw && raw.private_net) || []
  if (!nets || typeof nets.length !== "number") return result
  for (var i = 0; i < nets.length; i++) {
    var ip = str(nets[i] && nets[i].ip)
    if (ip !== "") result.push(ip)
  }
  return result
}

function labelPairs(raw) {
  var result = []
  var labels = (raw && raw.labels) || null
  if (!labels || typeof labels !== "object") return result
  for (var key in labels) result.push({ key: key, value: str(labels[key]) })
  result.sort(function(a, b) { return a.key.localeCompare(b.key) })
  return result
}

// The bridge joins /v1/volumes onto the server it fetched them alongside; the
// server object itself only carries ids, and the sizes are the point.
function attachedVolumes(server) {
  var result = []
  var list = (server && server.attached_volumes) || []
  if (!list || typeof list.length !== "number") return result
  for (var i = 0; i < list.length; i++) {
    var volume = list[i] || {}
    result.push({
      name: str(volume.name),
      size: num(volume.size),
      device: str(volume.linux_device),
      format: str(volume.format),
      status: str(volume.status)
    })
  }
  result.sort(function(a, b) { return a.name.localeCompare(b.name) })
  return result
}

function hasPendingFirewall(firewalls) {
  var list = firewalls || []
  for (var i = 0; i < list.length; i++) {
    if (str(list[i] && list[i].status) !== "applied") return true
  }
  return false
}

function normalizeServer(raw, projectLabel) {
  var server = raw || {}
  var publicNet = server.public_net || {}
  var ipv4 = publicNet.ipv4 || {}
  var ipv6 = publicNet.ipv6 || {}
  var type = server.server_type || {}
  var image = server.image || {}
  var privates = privateIps(server)
  return {
    rowKind: "server",
    id: str(server.id),
    project: str(projectLabel),
    name: str(server.name) || "Unnamed",
    status: str(server.status) || "unknown",
    tone: statusTone(server.status),
    locked: server.locked === true,
    ipv4: str(ipv4.ip),
    ipv4Dns: str(ipv4.dns_ptr),
    // Hetzner hands out a /64 written as "2a01:…::/64"; the usable address is
    // ::1 inside it, which is what people actually paste into a terminal.
    ipv6: str(ipv6.ip),
    privateIps: privates,
    privateIp: privates.length > 0 ? privates[0] : "",
    typeName: str(type.name),
    cores: num(type.cores),
    memory: num(type.memory),
    disk: num(type.disk),
    image: str(image.description) || str(image.name),
    osFlavor: str(image.os_flavor),
    osVersion: str(image.os_version),
    volumes: attachedVolumes(server),
    firewalls: (publicNet.firewalls || []).length,
    firewallPending: hasPendingFirewall(publicNet.firewalls),
    deleteProtected: !!(server.protection && server.protection.delete),
    rebuildProtected: !!(server.protection && server.protection.rebuild),
    rescueEnabled: server.rescue_enabled === true,
    isoName: str(server.iso && (server.iso.description || server.iso.name)),
    placementGroup: str(server.placement_group && server.placement_group.name),
    city: str(((server.datacenter || {}).location || {}).city),
    country: str(((server.datacenter || {}).location || {}).country),
    location: locationText(server),
    created: str(server.created),
    createdDate: formatCreated(server.created),
    backupWindow: str(server.backup_window),
    outgoingTraffic: num(server.outgoing_traffic),
    ingoingTraffic: num(server.ingoing_traffic),
    includedTraffic: num(server.included_traffic),
    labels: labelPairs(server)
  }
}

// The one-line grey subtitle under a server name.
function serverMeta(server) {
  if (!server) return ""
  var parts = []
  if (server.ipv4 !== "") parts.push(server.ipv4)
  var spec = []
  if (server.typeName !== "") spec.push(server.typeName)
  if (server.cores > 0) spec.push(String(server.cores) + " vCPU")
  if (server.memory > 0) spec.push(formatMemory(server.memory))
  if (spec.length > 0) parts.push(spec.join(" · "))
  if (server.location !== "") parts.push(server.location)
  return parts.join("  ·  ")
}

// The detail page. Rows that carry a `copy` value are clickable there, which
// is why there is no separate list of copy targets underneath: it repeated
// three of these verbatim and cost five rows of height to do it.
// A gap only earns its place between two groups that both have rows, so it is
// requested rather than placed: nothing at the top, nothing doubled, nothing
// dangling at the end.
function gap(rows) {
  if (rows.length > 0 && rows[rows.length - 1].gap !== true) rows.push({ gap: true })
}

function serverDetails(server) {
  if (!server) return []
  var rows = []
  var alias = sshAlias(sshAliasFor(server.project), server.name)

  if (server.ipv4 !== "") rows.push({ key: "IPv4", value: server.ipv4, copy: server.ipv4 })
  if (server.ipv6 !== "") rows.push({ key: "IPv6", value: server.ipv6, copy: server.ipv6 })
  if (server.privateIps.length > 0) {
    rows.push({ key: "Private", value: server.privateIps.join(", "), copy: server.privateIps[0] })
  }
  rows.push({ key: "Name", value: server.name, copy: server.name })
  if (alias !== "") rows.push({ key: "SSH", value: alias, copy: alias })

  gap(rows)
  if (server.image !== "") rows.push({ key: "Image", value: server.image })
  // The provisioned size. How full it is only the machine itself knows — the
  // API has no field for it, and metrics report disk I/O, not occupancy.
  if (server.disk > 0) rows.push({ key: "Disk", value: String(server.disk) + " GB" })
  for (var v = 0; v < server.volumes.length; v++) {
    var volume = server.volumes[v]
    var parts = [String(volume.size) + " GB"]
    if (volume.device !== "") parts.push(volume.device)
    if (volume.format !== "") parts.push(volume.format)
    if (volume.status !== "" && volume.status !== "available") parts.push(volume.status)
    rows.push({ key: v === 0 ? "Volumes" : "", value: volume.name + " · " + parts.join(" · ") })
  }
  gap(rows)
  if (server.includedTraffic > 0) {
    rows.push({
      key: "Traffic out",
      value: formatBytes(server.outgoingTraffic) + " of " + formatBytes(server.includedTraffic)
    })
  } else if (server.outgoingTraffic > 0) {
    rows.push({ key: "Traffic out", value: formatBytes(server.outgoingTraffic) })
  }
  if (server.ingoingTraffic > 0) rows.push({ key: "Traffic in", value: formatBytes(server.ingoingTraffic) })
  gap(rows)
  if (server.firewalls > 0) {
    rows.push({
      key: "Firewall",
      value: plural(server.firewalls, "rule set") + (server.firewallPending ? " · pending" : "")
    })
  }
  var guards = []
  if (server.deleteProtected) guards.push("delete")
  if (server.rebuildProtected) guards.push("rebuild")
  if (guards.length > 0) rows.push({ key: "Protected", value: guards.join(", ") })
  if (server.rescueEnabled) rows.push({ key: "Rescue", value: "enabled" })
  if (server.isoName !== "") rows.push({ key: "ISO", value: server.isoName })
  if (server.placementGroup !== "") rows.push({ key: "Placement", value: server.placementGroup })
  gap(rows)
  if (server.backupWindow !== "") rows.push({ key: "Backups", value: server.backupWindow + " UTC" })
  if (server.createdDate !== "") rows.push({ key: "Created", value: server.createdDate })
  for (var i = 0; i < server.labels.length; i++) {
    rows.push({ key: i === 0 ? "Labels" : "", value: server.labels[i].key + "=" + server.labels[i].value })
  }
  while (rows.length > 0 && rows[rows.length - 1].gap === true) rows.pop()
  return rows
}

function sshAlias(prefix, name) {
  var host = str(name)
  var scope = str(prefix)
  if (host === "") return ""
  return scope === "" ? host : scope + "/" + host
}

// A storage box offers what you would type to reach it. The kinds line up with
// the server ones where a key is shared: `c` copies the address you connect to,
// `n` the name, `s` what goes after `ssh`.
function boxCopyOptions(box) {
  var options = []
  if (!box) return options
  if (box.host !== "") options.push({ kind: "host", label: box.host })
  if (box.name !== "" && box.name !== box.host) options.push({ kind: "name", label: box.name })
  if (box.username !== "") options.push({ kind: "user", label: box.username })
  if (box.username !== "" && box.host !== "") {
    options.push({ kind: "ssh", label: "ssh " + box.username + "@" + box.host })
  }
  return options
}

function boxCopyValue(box, kind) {
  if (!box) return ""
  if (kind === "host" || kind === "ipv4") return box.host
  if (kind === "name") return box.name
  if (kind === "user") return box.username
  if (kind === "ssh") return box.username !== "" && box.host !== "" ? box.username + "@" + box.host : ""
  return ""
}

// Copy targets offered by a row, in the order the menu shows them. Entries
// with nothing to copy are left out rather than shown disabled.
function copyOptions(server, prefix) {
  var options = []
  if (!server) return options
  if (server.rowKind === "box") return boxCopyOptions(server)
  if (server.ipv4 !== "") options.push({ kind: "ipv4", label: server.ipv4 })
  if (server.name !== "") options.push({ kind: "name", label: server.name })
  if (server.ipv6 !== "") options.push({ kind: "ipv6", label: server.ipv6 })
  if (server.privateIp !== "") options.push({ kind: "private", label: server.privateIp })
  // With no project prefix the alias is just the name again, and a menu that
  // offers the same string twice is noise.
  var alias = sshAlias(prefix, server.name)
  if (alias !== "" && alias !== server.name) options.push({ kind: "ssh", label: "ssh " + alias })
  return options
}

function copyValue(server, kind, prefix) {
  if (!server) return ""
  if (server.rowKind === "box") return boxCopyValue(server, kind)
  if (kind === "ipv4") return server.ipv4
  if (kind === "name") return server.name
  if (kind === "ipv6") return server.ipv6
  if (kind === "private") return server.privateIp
  if (kind === "ssh") return sshAlias(prefix, server.name)
  return ""
}

function matchesQuery(server, query) {
  var q = str(query).trim().toLowerCase()
  if (q === "") return true
  var haystack = [
    server.name, server.status, server.ipv4, server.ipv6, server.privateIps.join(" "),
    server.typeName, server.location, server.image, server.project
  ]
  for (var i = 0; i < server.labels.length; i++) {
    haystack.push(server.labels[i].key + "=" + server.labels[i].value)
  }
  return haystack.join(" ").toLowerCase().indexOf(q) !== -1
}

// The bridge answers per keyring key. A label may own several, so the entries
// are merged back under it here: servers and boxes pooled, duplicates dropped,
// and one failing token marked against its label without hiding what the other
// tokens did return.
// The bridge caps what it emits; this is the shell's own line, drawn before
// JSON.parse gets to work on anything larger than that.
var MAX_BRIDGE_OUTPUT = 32 * 1024 * 1024

function parseBridge(raw, accounts) {
  var text = str(raw).trim()
  if (text === "") return { ok: false, projects: [], error: "The Hetzner bridge returned nothing" }
  if (text.length > MAX_BRIDGE_OUTPUT) {
    return { ok: false, projects: [], error: "The Hetzner bridge answer was too large to read" }
  }
  var data
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { ok: false, projects: [], error: "Could not read the Hetzner bridge output" }
  }
  if (!data || data.ok !== true) {
    return { ok: false, projects: [], error: str(data && data.error) || "Hetzner bridge failed" }
  }

  var byLabel = {}
  var order = []
  var entries = data.projects || []
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i] || {}
    var key = str(entry.label)
    var label = labelForKey(accounts, key)
    if (!byLabel[label]) {
      byLabel[label] = {
        label: label, ok: true, status: 200, error: "",
        servers: [], storageBoxes: [], storageBoxesError: "",
        _servers: {}, _boxes: {}
      }
      order.push(label)
    }
    var group = byLabel[label]

    if (entry.ok !== true) {
      group.ok = false
      group.status = num(entry.status)
      group.error = group.error === "" ? str(entry.error)
        : group.error + " · " + str(entry.error)
    }

    var rawServers = entry.servers || []
    for (var j = 0; j < rawServers.length; j++) {
      var server = normalizeServer(rawServers[j], label)
      if (group._servers[server.id]) continue
      group._servers[server.id] = true
      group.servers.push(server)
    }

    var rawBoxes = entry.storage_boxes || []
    for (var b = 0; b < rawBoxes.length; b++) {
      var box = normalizeStorageBox(rawBoxes[b], label)
      if (group._boxes[box.id]) continue
      group._boxes[box.id] = true
      group.storageBoxes.push(box)
    }
    if (str(entry.storage_boxes_error) !== "" && group.storageBoxesError === "") {
      group.storageBoxesError = str(entry.storage_boxes_error)
    }
  }

  var projects = []
  for (var k = 0; k < order.length; k++) {
    var g = byLabel[order[k]]
    g.servers.sort(function(a, b) { return a.name.localeCompare(b.name) })
    delete g._servers
    delete g._boxes
    projects.push(g)
  }
  return { ok: true, projects: projects, error: "" }
}

// A project that failed this time round keeps what it showed last time. A read
// that timed out once a minute was blanking whole groups; the stale list under
// the error is more use than an empty one, and canSyncSsh still refuses it.
function retainPrevious(next, previous) {
  var byLabel = {}
  var old = previous || []
  for (var i = 0; i < old.length; i++) if (old[i]) byLabel[str(old[i].label)] = old[i]
  var list = next || []
  var result = []
  for (var j = 0; j < list.length; j++) {
    var project = list[j]
    var kept = byLabel[str(project.label)]
    var empty = (project.servers || []).length === 0 && (project.storageBoxes || []).length === 0
    if (project.ok === true || !empty || !kept) { result.push(project); continue }
    var had = (kept.servers || []).length > 0 || (kept.storageBoxes || []).length > 0
    if (!had) { result.push(project); continue }
    var merged = {}
    for (var key in project) merged[key] = project[key]
    merged.servers = kept.servers || []
    merged.storageBoxes = kept.storageBoxes || []
    merged.stale = true
    result.push(merged)
  }
  return result
}

// Flattens the project tree into render groups while assigning every visible
// server a single panel-wide row index, so j/k walks straight across project
// boundaries instead of needing a cursor per section.
function buildGroups(projects, query) {
  var groups = []
  var offset = 0
  var total = 0
  var failed = 0
  var seenBox = {}
  var list = projects || []
  for (var i = 0; i < list.length; i++) {
    var project = list[i] || {}
    var servers = project.servers || []
    var visible = []
    for (var j = 0; j < servers.length; j++) {
      if (matchesQuery(servers[j], query)) visible.push(servers[j])
    }
    total += servers.length
    if (project.ok !== true) failed++

    // Boxes belong to the project whose token reported them. Whether the
    // endpoint is account-wide or project-scoped is not something one account
    // can settle, so a box seen twice stays with the first project that had
    // it rather than being listed under both.
    var boxes = []
    var projectBoxes = project.storageBoxes || []
    for (var b = 0; b < projectBoxes.length; b++) {
      var box = projectBoxes[b]
      if (!box || seenBox[box.id]) continue
      if (!matchesBoxQuery(box, query)) continue
      seenBox[box.id] = true
      boxes.push(box)
    }

    // While a search is running, a project with nothing to show is noise: you
    // narrowed the list yourself. A project that failed to load is not — it
    // has to stay visible, or a broken token disappears exactly when you are
    // looking for something and you conclude the server is gone.
    var matches = visible.length + boxes.length
    groups.push({
      label: project.label,
      ok: project.ok === true,
      status: num(project.status),
      error: str(project.error),
      stale: project.stale === true,
      servers: visible,
      boxes: boxes,
      boxesError: str(project.storageBoxesError),
      count: servers.length,
      matches: matches,
      hidden: str(query).trim() !== "" && matches === 0 && project.ok === true,
      offset: offset
    })
    // Boxes take the indices after their project's servers, so one cursor
    // walks servers, then boxes, then on to the next project.
    offset += visible.length + boxes.length
  }
  return { groups: groups, matched: offset, total: total, failed: failed }
}

function matchesBoxQuery(box, query) {
  var q = str(query).trim().toLowerCase()
  if (q === "") return true
  return [box.name, box.host, box.username, box.product, box.location]
    .join(" ").toLowerCase().indexOf(q) !== -1
}

function flatServers(groups) {
  var result = []
  var list = (groups && groups.groups) || []
  for (var i = 0; i < list.length; i++) {
    for (var j = 0; j < list[i].servers.length; j++) result.push(list[i].servers[j])
  }
  return result
}

// Every row the cursor can land on, in the order it meets them: each
// project's servers, then its boxes. Index n here is offset n in buildGroups.
function flatRows(groups) {
  var result = []
  var list = (groups && groups.groups) || []
  for (var i = 0; i < list.length; i++) {
    var group = list[i]
    for (var j = 0; j < group.servers.length; j++) result.push(group.servers[j])
    var boxes = group.boxes || []
    for (var b = 0; b < boxes.length; b++) result.push(boxes[b])
  }
  return result
}

// Rows register themselves under this key. Servers and boxes come from two
// APIs, so their numeric ids may collide; the kind keeps them apart.
function rowKey(row) {
  if (!row) return ""
  return row.rowKind === "box" ? "box:" + str(row.id) : str(row.id)
}

// "1 min", "15 min", "1 h", "24 h" — for the interval buttons and their caption.
function intervalLabel(seconds) {
  var n = num(seconds)
  if (n <= 0) return ""
  if (n % 3600 === 0) return String(n / 3600) + " h"
  if (n % 60 === 0) return String(n / 60) + " min"
  return String(n) + " s"
}

function plural(count, word) {
  return String(count) + " " + word + (count === 1 ? "" : "s")
}

// Bar tooltip and hero subtitle: the shortest true sentence about right now.
function summaryText(groups, labelCount, query) {
  if (labelCount === 0) return "No project token yet"
  if (!groups) return "Loading…"
  // Searching, the interesting number is how much survived it.
  if (str(query).trim() !== "") {
    return String(groups.matched) + " of " + plural(groups.total, "server")
  }
  if (groups.failed > 0 && groups.total === 0) return plural(groups.failed, "project") + " failed"
  var text = plural(groups.total, "server") + " in " + plural(groups.groups.length, "project")
  if (groups.failed > 0) text += " · " + String(groups.failed) + " failed"
  return text
}

// ---------------------------------------------------------------- sparkline

// A single current value with a trend is a stat tile: the number carries the
// reading, the curve only answers "is this a spike or has it been like this".
// So the curve gets no axes, no grid and no legend, and every number it could
// have been asked for is printed beside it.
function seriesStats(values) {
  var list = values || []
  if (list.length === 0) return { count: 0, current: 0, peak: 0, low: 0, average: 0 }
  var peak = list[0]
  var low = list[0]
  var total = 0
  for (var i = 0; i < list.length; i++) {
    if (list[i] > peak) peak = list[i]
    if (list[i] < low) low = list[i]
    total += list[i]
  }
  return {
    count: list.length,
    current: list[list.length - 1],
    peak: peak,
    low: low,
    average: total / list.length
  }
}

// Zero baseline, top follows the peak. A floor that never starts at zero turns
// a server idling between 1.1 and 1.4 percent into a mountain range; a top
// pinned to 100 flattens every real machine into a straight line. Zero plus an
// adaptive top is honest in both directions, and the peak is printed so the
// scale is never left implicit.
function sparklinePoints(values, width, height) {
  var list = values || []
  var points = []
  if (list.length < 2 || width <= 0 || height <= 0) return points
  var stats = seriesStats(list)
  var top = stats.peak > 0 ? stats.peak : 1
  var stepX = width / (list.length - 1)
  for (var i = 0; i < list.length; i++) {
    var ratio = Math.max(0, Math.min(1, list[i] / top))
    // Pixel coordinates, so two decimals is more precision than the screen
    // has; carrying the float error through only makes them awkward to test.
    points.push({
      x: Math.round(i * stepX * 100) / 100,
      y: Math.round((height - ratio * height) * 100) / 100
    })
  }
  return points
}

function formatPercent(value) {
  return (Math.round(num(value) * 10) / 10) + " %"
}

var WINDOW_LABELS = [
  { seconds: 3600, label: "1h" },
  { seconds: 86400, label: "24h" },
  { seconds: 604800, label: "7d" }
]

function windowLabel(seconds) {
  for (var i = 0; i < WINDOW_LABELS.length; i++) {
    if (WINDOW_LABELS[i].seconds === num(seconds)) return WINDOW_LABELS[i].label
  }
  return ""
}

// ---------------------------------------------------------------- metrics

function formatRate(bytesPerSecond) {
  var value = formatBytes(bytesPerSecond)
  return value === "" ? "0 B/s" : value + "/s"
}

// Whatever Hetzner returns, reduced to the handful of lines worth a row. Note
// what is absent: there is no disk occupancy anywhere in this response, only
// throughput and operations.
//
// The rows are always there. A page that gains two rows and a chart when the
// answer lands grows under the reader's hand, so the space is taken from the
// start: an ellipsis while the request is out, a dash when it came back with
// nothing to say.
function metricRows(metrics, pending) {
  var m = metrics || {}
  var blank = pending ? "…" : "—"
  var inRate = m["network.0.bandwidth.in"]
  var outRate = m["network.0.bandwidth.out"]
  var readOps = m["disk.0.iops.read"]
  var writeOps = m["disk.0.iops.write"]
  return [
    { gap: true },
    {
      key: "Network",
      value: typeof inRate === "number" || typeof outRate === "number"
        ? formatRate(inRate || 0) + " in · " + formatRate(outRate || 0) + " out" : blank
    },
    {
      key: "Disk I/O",
      value: typeof readOps === "number" || typeof writeOps === "number"
        ? Math.round(readOps || 0) + " read · " + Math.round(writeOps || 0) + " write IOPS" : blank
    }
  ]
}

// Whether a metrics answer is still on its way: nothing arrived and nothing
// failed. Drives the ellipsis-versus-dash choice above.
function metricsPending(metrics, error) {
  if (str(error) !== "") return false
  var m = metrics || {}
  for (var key in m) return false
  return true
}

function parseMetrics(raw) {
  var text = str(raw).trim()
  if (text === "") return { ok: false, metrics: {}, series: [], window: 0,
                            error: "No answer from the metrics endpoint" }
  if (text.length > MAX_BRIDGE_OUTPUT) {
    return { ok: false, metrics: {}, series: [], window: 0, error: "The metrics answer was too large to read" }
  }
  try {
    var data = JSON.parse(text)
    // A partial answer is still worth showing; the note rides along with it.
    if (data && data.ok === true) {
      return {
        ok: true, metrics: data.metrics || {}, error: "",
        partial: str(data.partial),
        series: (data.series || {}).cpu || [],
        window: num(data.window)
      }
    }
    return { ok: false, metrics: {}, series: [], window: 0,
             error: str(data && data.error) || "Could not read metrics" }
  } catch (e) {
    return { ok: false, metrics: {}, series: [], window: 0, error: "Could not read metrics" }
  }
}

// ---------------------------------------------------------- storage boxes

// Hetzner's newer API serves these to the same project token the servers come
// from, so unlike the old Robot route there is no second credential. Sizes are
// bytes here, and `stats.size` is the one thing a cloud server cannot report
// about itself: how full it actually is.
function normalizeStorageBox(raw, projectLabel) {
  var box = raw || {}
  var type = box.storage_box_type || {}
  var place = box.location || {}
  var stats = box.stats || {}
  var access = box.access_settings || {}
  var quota = num(type.size)
  var used = num(stats.size)
  return {
    rowKind: "box",
    id: str(box.id),
    project: str(projectLabel),
    name: str(box.name) || str(box.username) || "Storage Box",
    username: str(box.username),
    host: str(box.server),
    system: str(box.system),
    status: str(box.status) || "unknown",
    product: str(type.description) || str(type.name),
    city: str(place.city),
    country: str(place.country),
    location: str(place.city) !== "" && str(place.country) !== ""
      ? str(place.city) + ", " + str(place.country)
      : (str(place.city) || str(place.name)),
    quota: quota,
    used: used,
    usedData: num(stats.size_data),
    usedSnapshots: num(stats.size_snapshots),
    percent: quota > 0 ? Math.min(100, Math.round(used / quota * 1000) / 10) : 0,
    deleteProtected: !!(box.protection && box.protection["delete"]),
    externallyReachable: access.reachable_externally === true,
    snapshotPlan: !!box.snapshot_plan,
    snapshotLimit: num(type.snapshot_limit),
    services: storageBoxServices(access),
    created: str(box.created),
    createdDate: formatCreated(box.created)
  }
}

function storageBoxServices(access) {
  var on = []
  var settings = access || {}
  if (settings.ssh_enabled === true) on.push("SSH")
  if (settings.samba_enabled === true) on.push("Samba")
  if (settings.webdav_enabled === true) on.push("WebDAV")
  if (settings.zfs_enabled === true) on.push("ZFS")
  return on
}

function storageBoxUsageText(box) {
  if (!box || box.quota <= 0) return ""
  return formatBytes(box.used) + " of " + formatBytes(box.quota) + " · " + box.percent + " %"
}

function storageBoxTone(box) {
  if (!box) return "bad"
  if (box.status !== "active") return "bad"
  if (box.percent >= 90) return "bad"
  if (box.percent >= 75) return "busy"
  return "live"
}

function storageBoxMeta(box) {
  if (!box) return ""
  var parts = []
  if (box.product !== "") parts.push(box.product)
  if (box.location !== "") parts.push(box.location)
  if (box.host !== "") parts.push(box.host)
  if (box.services.length > 0) parts.push(box.services.join(" · "))
  return parts.join("  ·  ")
}

function storageBoxDetails(box) {
  if (!box) return []
  var rows = []
  if (box.host !== "") rows.push({ key: "Host", value: box.host, copy: box.host })
  if (box.username !== "") rows.push({ key: "User", value: box.username, copy: box.username })
  if (box.host !== "" && box.username !== "") {
    rows.push({ key: "SSH", value: box.username + "@" + box.host, copy: box.username + "@" + box.host })
  }
  if (box.usedSnapshots > 0 || box.usedData > 0) {
    rows.push({
      key: "Breakdown",
      value: bytesOrZero(box.usedData) + " data · " + bytesOrZero(box.usedSnapshots) + " snapshots"
    })
  }
  gap(rows)
  if (box.snapshotLimit > 0) rows.push({ key: "Snapshots", value: "up to " + box.snapshotLimit })
  if (box.deleteProtected) rows.push({ key: "Protected", value: "delete" })
  if (!box.externallyReachable) rows.push({ key: "Reachable", value: "internal only" })
  if (box.system !== "") rows.push({ key: "System", value: box.system })
  if (box.createdDate !== "") rows.push({ key: "Created", value: box.createdDate })
  while (rows.length > 0 && rows[rows.length - 1].gap === true) rows.pop()
  return rows
}

// Whether the endpoint is scoped to a project or covers the account is not
// something one project can tell you, so the same box may come back under
// several tokens. Keyed by id, first one wins.
function collectStorageBoxes(projects) {
  var result = []
  var seen = {}
  var list = projects || []
  for (var i = 0; i < list.length; i++) {
    var boxes = (list[i] && list[i].storageBoxes) || []
    for (var j = 0; j < boxes.length; j++) {
      var box = boxes[j]
      if (!box || seen[box.id]) continue
      seen[box.id] = true
      result.push(box)
    }
  }
  result.sort(function(a, b) { return a.name.localeCompare(b.name) })
  return result
}

function storageBoxError(projects) {
  var list = projects || []
  for (var i = 0; i < list.length; i++) {
    if (list[i] && str(list[i].storageBoxesError) !== "") return str(list[i].storageBoxesError)
  }
  return ""
}

// ---------------------------------------------------------------- os marks

// Hetzner reports image.os_flavor as one of ubuntu, debian, centos, fedora,
// rocky, alma or unknown. Snapshots and custom images fall through to a name
// sniff, and anything still unrecognised gets the generic penguin rather than
// a blank column.
var OS_GLYPHS = {
  ubuntu: "",
  debian: "",
  centos: "",
  fedora: "",
  rocky: "",
  alma: "",
  arch: "",
  alpine: "",
  opensuse: "",
  gentoo: "",
  freebsd: ""
}

function osKey(server) {
  if (!server) return ""
  var flavor = str(server.osFlavor).toLowerCase()
  if (flavor !== "" && flavor !== "unknown" && OS_GLYPHS[flavor]) return flavor
  var haystack = (str(server.image) + " " + str(server.osFlavor)).toLowerCase()
  for (var key in OS_GLYPHS) {
    if (haystack.indexOf(key) !== -1) return key
  }
  if (haystack.indexOf("suse") !== -1) return "opensuse"
  if (haystack.indexOf("bsd") !== -1) return "freebsd"
  return ""
}

function osGlyph(server) {
  var key = osKey(server)
  return key !== "" ? OS_GLYPHS[key] : ""
}

function osLabel(server) {
  if (!server) return ""
  var image = str(server.image)
  if (image !== "") return image
  var key = osKey(server)
  return key !== "" ? key.charAt(0).toUpperCase() + key.slice(1) : "Unknown image"
}

// ---------------------------------------------------------------- accounts

// One entry per label: { label, keys }. A label groups one or more Hetzner
// projects — their servers appear together under it — and each key names one
// token in the keyring. The ssh alias prefix is derived from the label by
// sshAliasFor() rather than stored beside it: a parallel map went stale the
// moment a token was removed, and left the copy menu offering an ssh alias the
// synced config did not contain.
//
// Older installs stored `accountLabels: []` plus `sshPrefixes: {}`, and before
// that a single key equal to the label. Both are folded in on read; the next
// change writes the current shape.
function normalizeAccounts(settings) {
  var config = settings || {}
  var result = []
  var seen = {}

  function push(label, keys) {
    var name = str(label).trim()
    if (name === "" || seen[name]) return
    seen[name] = true
    var list = []
    var raw = keys || []
    if (raw && typeof raw.length === "number") {
      for (var i = 0; i < raw.length; i++) {
        var key = str(raw[i]).trim()
        if (key !== "" && list.indexOf(key) === -1) list.push(key)
      }
    }
    // A label with no keys recorded is one from before they existed: its
    // single token sits in the keyring under the label itself.
    if (list.length === 0) list.push(name)
    result.push({ label: name, keys: list })
  }

  var accounts = config.accounts
  if (accounts && typeof accounts.length === "number") {
    for (var i = 0; i < accounts.length; i++) {
      var entry = accounts[i]
      if (entry && typeof entry === "object") push(entry.label, entry.keys)
      else push(entry, null)
    }
    return result
  }

  var legacyLabels = config.accountLabels
  if (legacyLabels && typeof legacyLabels.length === "number") {
    for (var j = 0; j < legacyLabels.length; j++) push(legacyLabels[j], null)
  }
  return result
}

// The labels of demo/fleet.json, for when the panel runs on invented data.
function demoAccounts() {
  return [{ label: "production", keys: ["production"] }, { label: "staging", keys: ["staging"] }]
}

// Every keyring account name, in the order the bridge should be asked for them.
function accountKeys(accounts) {
  var keys = []
  var list = accounts || []
  for (var i = 0; i < list.length; i++) {
    for (var j = 0; j < list[i].keys.length; j++) keys.push(list[i].keys[j])
  }
  return keys
}

function labelForKey(accounts, key) {
  var name = str(key)
  var list = accounts || []
  for (var i = 0; i < list.length; i++) {
    if (list[i].keys.indexOf(name) !== -1) return list[i].label
  }
  return name
}

// A fresh keyring name for another token under an existing label. The first is
// the label itself, so older single-token installs keep working untouched.
function nextKey(accounts, label) {
  var name = str(label).trim()
  if (name === "") return ""
  var taken = accountKeys(accounts)
  if (taken.indexOf(name) === -1) return name
  for (var n = 2; n < 1000; n++) {
    var candidate = name + "-" + n
    if (taken.indexOf(candidate) === -1) return candidate
  }
  return ""
}

function addAccountKey(accounts, label, key) {
  var name = str(label).trim()
  var value = str(key).trim()
  if (name === "" || value === "") return (accounts || []).slice()
  var next = []
  var found = false
  var list = accounts || []
  for (var i = 0; i < list.length; i++) {
    if (list[i].label !== name) { next.push(list[i]); continue }
    found = true
    var keys = list[i].keys.slice()
    if (keys.indexOf(value) === -1) keys.push(value)
    next.push({ label: list[i].label, keys: keys })
  }
  if (!found) next.push({ label: name, keys: [value] })
  return next
}

function accountLabels(accounts) {
  var result = []
  var list = accounts || []
  for (var i = 0; i < list.length; i++) result.push(str(list[i].label))
  return result
}

// One name, not two. A label is what you call the project here and what you
// ssh to, because nobody wants to keep two names in step — but a label may
// carry spaces, capitals or a slash, and an ssh Host pattern had better not.
// So the alias is derived rather than typed a second time.
var ALIAS_FOLD = [["ä", "ae"], ["ö", "oe"], ["ü", "ue"], ["ß", "ss"],
                  ["á", "a"], ["à", "a"], ["é", "e"], ["è", "e"], ["í", "i"],
                  ["ó", "o"], ["ú", "u"], ["ñ", "n"], ["ç", "c"]]

function sshAliasFor(label) {
  var alias = str(label).toLowerCase()
  // Fold the letters a German or French project name is likely to carry,
  // rather than dropping them and turning "Räume" into "r-ume".
  for (var i = 0; i < ALIAS_FOLD.length; i++) {
    alias = alias.split(ALIAS_FOLD[i][0]).join(ALIAS_FOLD[i][1])
  }
  alias = alias.replace(/[^a-z0-9._-]+/g, "-")
  alias = alias.replace(/-+/g, "-")
  alias = alias.replace(/^[-.]+|[-.]+$/g, "")
  return alias !== "" ? alias : "project"
}

function addAccount(accounts, label) {
  return addAccountKey(accounts, label, nextKey(accounts, label))
}

function removeAccount(accounts, label) {
  var name = str(label).trim()
  var next = []
  var list = accounts || []
  // Dropping the whole entry takes the prefix with it. That is the point.
  for (var i = 0; i < list.length; i++) if (list[i].label !== name) next.push(list[i])
  return next
}

// ---------------------------------------------------------------- ssh config

// A project that failed to load has no servers, and syncing that would delete
// its hosts out of ~/.ssh/config over a passing 401 or a dropped network. Only
// a complete picture is safe to write.
function canSyncSsh(projects) {
  var list = projects || []
  if (list.length === 0) return false
  for (var i = 0; i < list.length; i++) {
    if (!list[i] || list[i].ok !== true) return false
  }
  return true
}

function sshHosts(projects) {
  var hosts = []
  var seen = {}
  var list = projects || []
  for (var i = 0; i < list.length; i++) {
    var project = list[i] || {}
    var prefix = sshAliasFor(project.label)
    var servers = project.servers || []
    for (var j = 0; j < servers.length; j++) {
      var server = servers[j]
      if (!server || server.ipv4 === "") continue
      var alias = sshAlias(prefix, server.name)
      if (alias === "" || seen[alias]) continue
      seen[alias] = true
      hosts.push({ alias: alias, ip: server.ipv4 })
    }
  }
  hosts.sort(function(a, b) { return a.alias.localeCompare(b.alias) })
  return hosts
}

function syncStatusText(enabled, result) {
  if (!enabled) return "Off"
  if (!result || !result.at) return "Waiting for the next refresh"
  if (result.error !== "") return result.error
  return plural(result.hosts, "host") + " written \u00b7 " + result.at
}

if (typeof module !== "undefined") {
  module.exports = {
    statusTone: statusTone,
    isTransitional: isTransitional,
    formatBytes: formatBytes,
    bytesOrZero: bytesOrZero,
    formatMemory: formatMemory,
    formatCreated: formatCreated,
    locationText: locationText,
    privateIps: privateIps,
    labelPairs: labelPairs,
    normalizeServer: normalizeServer,
    serverMeta: serverMeta,
    serverDetails: serverDetails,
    sshAlias: sshAlias,
    copyOptions: copyOptions,
    copyValue: copyValue,
    matchesQuery: matchesQuery,
    parseBridge: parseBridge,
    buildGroups: buildGroups,
    retainPrevious: retainPrevious,
    flatServers: flatServers,
    flatRows: flatRows,
    rowKey: rowKey,
    plural: plural,
    intervalLabel: intervalLabel,
    boxCopyOptions: boxCopyOptions,
    boxCopyValue: boxCopyValue,
    summaryText: summaryText,
    attachedVolumes: attachedVolumes,
    formatRate: formatRate,
    metricRows: metricRows,
    metricsPending: metricsPending,
    seriesStats: seriesStats,
    sparklinePoints: sparklinePoints,
    formatPercent: formatPercent,
    windowLabel: windowLabel,
    parseMetrics: parseMetrics,
    normalizeStorageBox: normalizeStorageBox,
    storageBoxUsageText: storageBoxUsageText,
    storageBoxTone: storageBoxTone,
    storageBoxMeta: storageBoxMeta,
    storageBoxDetails: storageBoxDetails,
    collectStorageBoxes: collectStorageBoxes,
    matchesBoxQuery: matchesBoxQuery,
    storageBoxError: storageBoxError,
    osKey: osKey,
    osGlyph: osGlyph,
    osLabel: osLabel,
    normalizeAccounts: normalizeAccounts,
    demoAccounts: demoAccounts,
    accountLabels: accountLabels,
    accountKeys: accountKeys,
    labelForKey: labelForKey,
    nextKey: nextKey,
    addAccountKey: addAccountKey,
    sshAliasFor: sshAliasFor,
    addAccount: addAccount,
    removeAccount: removeAccount,
    canSyncSsh: canSyncSsh,
    sshHosts: sshHosts,
    syncStatusText: syncStatusText
  }
}
