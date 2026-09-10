import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Shapes
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Bar button plus panel for Hetzner Cloud. Read-only by design: this widget
// lists and copies, it never powers a machine on or off, so a misplaced Enter
// cannot take down production.
//
// manageIpc stays false because the shell registers the IPC target itself and
// a bar widget is instantiated once per monitor — letting the base class claim
// the target would have every monitor fight over the same name.
Panel {
  id: root
  moduleName: "io.github.ndrsgg.hcloud"
  ipcTarget: "io.github.ndrsgg.hcloud"
  manageIpc: false

  property string view: "servers"
  property string focusSection: "header"
  property int serverIndex: 0
  property int tokenIndex: 0
  property bool cursorActive: false
  property bool copyMenuOpen: false
  property bool addTokenOpen: false
  property string query: ""

  // Theme surface. Every color in this file comes from one of these, so the
  // widget follows whatever theme the user is running.
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color accent: Color.accent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color hoverFill: bar ? Style.hoverFillFor(bar.foreground, Color.accent) : "transparent"
  readonly property color selectedFill: bar ? Style.selectedFillFor(bar.foreground, Color.accent) : "transparent"
  readonly property color barIconColor: healthy ? barForeground : Qt.darker(barForeground, 1.55)

  readonly property var labels: hcloud.labels
  readonly property bool hasLabels: labels.length > 0
  readonly property var groups: Model.buildGroups(hcloud.projects, query)
  // Servers and storage boxes share one cursor: each project's servers, then
  // its boxes, then the next project.
  readonly property var visibleRows: Model.flatRows(groups)
  // The field earns its space once there are enough rows to lose one in, but
  // `/` should always reach it.
  property bool searchRevealed: false
  // The row being looked at in the detail view, or "". Servers are keyed by
  // their id, storage boxes by "box:<id>".
  property string detailId: ""

  readonly property var detailServer: {
    if (detailId === "" || detailId.indexOf("box:") === 0) return null
    for (var i = 0; i < visibleRows.length; i++) {
      if (visibleRows[i].rowKind === "server" && String(visibleRows[i].id) === detailId) return visibleRows[i]
    }
    return null
  }
  readonly property var detailBox: {
    if (detailId.indexOf("box:") !== 0) return null
    var wanted = detailId.substring(4)
    for (var i = 0; i < hcloud.boxes.length; i++) {
      if (String(hcloud.boxes[i].id) === wanted) return hcloud.boxes[i]
    }
    return null
  }
  readonly property string detailTitle: detailServer ? detailServer.name
    : (detailBox ? detailBox.name : "Hetzner Cloud")
  readonly property bool metricsPending: Model.metricsPending(hcloud.metrics, hcloud.metricsError)
  readonly property var cpuStats: Model.seriesStats(
    detailServer && hcloud.metricsServerId === String(detailServer.id) ? hcloud.metricsSeries : [])
  readonly property var sparkPath: {
    var pts = Model.sparklinePoints(
      detailServer && hcloud.metricsServerId === String(detailServer.id) ? hcloud.metricsSeries : [],
      spark ? spark.width : 0, spark ? spark.height : 0)
    var out = []
    for (var i = 0; i < pts.length; i++) out.push(Qt.point(pts[i].x, pts[i].y))
    return out
  }

  readonly property var detailRows: {
    if (detailServer) {
      var rows = Model.serverDetails(detailServer)
      if (hcloud.metricsServerId === String(detailServer.id)) {
        // Always the same two rows, so the page has its height before the
        // answer lands. What went wrong is said under the CPU tile.
        rows = rows.concat(Model.metricRows(hcloud.metrics, root.metricsPending))
      }
      return rows
    }
    return detailBox ? Model.storageBoxDetails(detailBox) : []
  }
  readonly property bool showSearch: hasLabels && (groups.total > 8 || query !== "" || searchRevealed)
  readonly property bool healthy: hasLabels && hcloud.lastError === "" && groups.failed === 0 && hcloud.loaded
  readonly property string summary: Model.summaryText(hcloud.loaded ? groups : null, labels.length, query)
  readonly property string barTooltip: {
    if (!hasLabels) return "Hetzner Cloud — add a project token"
    if (hcloud.lastError !== "") return "Hetzner Cloud — " + hcloud.lastError
    if (!hcloud.loaded) return "Hetzner Cloud — loading…"
    return "Hetzner Cloud — " + summary
  }
  readonly property bool editing: searchField.activeFocus || labelField.activeFocus
    || tokenField.activeFocus

  // State names from Model.js resolved against theme roles. The palette has no
  // green — Color offers foreground, background, accent, urgent and muted, and
  // the greens themes define in their own colors.toml are not passed through —
  // so a healthy machine takes the accent. That is a distinct colour in every
  // shipped theme but kanagawa, where it equals the foreground.
  //
  // A machine mid-transition takes the plain foreground and pulses: quieter
  // than running, and the movement is what marks it out.
  function toneColor(tone) {
    if (tone === "off") return dim
    if (tone === "busy") return foreground
    if (tone === "bad") return urgent
    return accent
  }

  function selectedRow() {
    if (visibleRows.length === 0) return null
    return visibleRows[Math.max(0, Math.min(serverIndex, visibleRows.length - 1))]
  }

  function selectedLabel() {
    if (labels.length === 0) return ""
    return String(labels[Math.max(0, Math.min(tokenIndex, labels.length - 1))])
  }

  function copySelected(kind) {
    var row = selectedRow()
    if (!row) return
    hcloud.copyToClipboard(Model.copyValue(row, kind, prefixFor(row.project)))
  }

  // The settings view is the only place a token can be added, so a fresh
  // install cannot leave it until there is one.
  function toggleView() {
    if (view === "detail") { closeDetail(); return }
    if (view === "settings" && !hasLabels) return
    view = view === "settings" ? "servers" : "settings"
    focusSection = "header"
    cursorActive = false
    if (panelFlick) panelFlick.contentY = 0
    if (view === "settings") addTokenOpen = !hasLabels
    leaveEditing()
  }

  function ensureCursor() {
    if (serverIndex >= visibleRows.length) serverIndex = Math.max(0, visibleRows.length - 1)
    if (tokenIndex >= labels.length) tokenIndex = Math.max(0, labels.length - 1)
    // A section that belongs to the other view is never the cursor's home.
    if (view !== "settings" && focusSection === "tokens") focusSection = "header"
    if (view !== "servers" && focusSection === "servers") focusSection = "header"
    if (focusSection === "servers" && visibleRows.length === 0) focusSection = "header"
    if (focusSection === "tokens" && !hasLabels) focusSection = "header"
  }

  function moveCursor(dx, dy) {
    cursorActive = true
    ensureCursor()
    // Right walks into a row, left backs out of it — the two directions the
    // key catcher already emits and nothing else was using.
    if (dx > 0 && view === "servers" && focusSection === "servers") { openSelectedDetail(); return }
    if (dx < 0 && view === "detail") { closeDetail(); return }
    if (dy === 0) return
    if (focusSection === "header") {
      if (dy > 0) {
        if (view === "servers" && visibleRows.length > 0) { focusSection = "servers"; serverIndex = 0 }
        else if (view === "settings" && hasLabels) { focusSection = "tokens"; tokenIndex = 0 }
      }
    } else if (focusSection === "servers") {
      if (dy < 0) {
        if (serverIndex <= 0) focusSection = "header"
        else serverIndex--
      } else if (serverIndex < visibleRows.length - 1) {
        serverIndex++
        }
    } else if (focusSection === "tokens") {
      if (dy < 0) {
        if (tokenIndex > 0) tokenIndex--
        else focusSection = "header"
      } else if (tokenIndex < labels.length - 1) {
        tokenIndex++
        }
    }
    ensureCursor()
  }

  function activateCursor() {
    ensureCursor()
    if (focusSection === "header") hcloud.refreshManually()
    else if (focusSection === "servers") openSelectedCopyMenu()
    else if (focusSection === "tokens") toggleView()
  }

  // A page rather than an expander. Nothing in the list moves, there is room
  // for everything the API knows, and the shell's own panels avoid content
  // that shoves the rows below it down — network says so in a comment.
  function openDetail(id, project) {
    detailId = String(id || "")
    if (detailId === "") return
    view = "detail"
    cursorActive = false
    if (panelFlick) panelFlick.contentY = 0
    if (detailId.indexOf("box:") === 0) hcloud.clearMetrics()
    else hcloud.requestMetrics(project, detailId)
  }

  function closeDetail() {
    detailId = ""
    view = "servers"
    hcloud.clearMetrics()
    if (panelFlick) panelFlick.contentY = 0
  }

  function openSelectedDetail() {
    var row = selectedRow()
    if (!row) return
    if (row.rowKind === "box") openDetail("box:" + row.id, "")
    else openDetail(row.id, row.project)
  }

  function openSelectedCopyMenu() {
    var row = selectedRow()
    if (!row) return
    var item = serverRows[rowKey(row)]
    if (item && item.openCopyMenu) item.openCopyMenu()
  }

  // Rows register themselves so Enter can open the copy menu of whatever the
  // keyboard cursor is on. Keyed by Model.rowKey, which survives a refresh
  // that reorders the list and keeps a box apart from a server with the same
  // number.
  property var serverRows: ({})

  function rowKey(row) {
    return Model.rowKey(row)
  }

  function registerServerRow(key, item) {
    if (item === null) delete serverRows[String(key)]
    else serverRows[String(key)] = item
  }

  function scrollItemIntoView(item) {
    if (!panelFlick || !item) return
    Qt.callLater(function() {
      if (!item) return
      var margin = Style.space(6)
      var point = item.mapToItem(panelFlick.contentItem, 0, 0)
      var top = point.y
      var bottom = top + item.height
      var viewTop = panelFlick.contentY
      var viewBottom = viewTop + panelFlick.height
      var maxY = Math.max(0, panelFlick.contentHeight - panelFlick.height)
      if (top < viewTop + margin) panelFlick.contentY = Math.max(0, top - margin)
      else if (bottom > viewBottom - margin) panelFlick.contentY = Math.min(maxY, bottom + margin - panelFlick.height)
    })
  }

  function setHeaderCursor() {
    cursorActive = true
    focusSection = "header"
  }

  function setServerCursor(index) {
    cursorActive = true
    focusSection = "servers"
    serverIndex = index
  }

  function setTokenCursor(index) {
    cursorActive = true
    focusSection = "tokens"
    tokenIndex = index
  }

  function focusSearch() {
    if (view !== "servers" || !hasLabels) return
    searchRevealed = true
    Qt.callLater(function() { searchField.forceActiveFocus() })
  }

  function leaveEditing() {
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  // Writes one key of this widget's inline shell.json entry, leaving the rest
  // as it found them.
  function persistSetting(name, value) {
    if (!bar || !bar.shell || typeof bar.shell.updateEntryInline !== "function") return
    var entry = { id: moduleName }
    for (var key in settings) if (key !== "id") entry[key] = settings[key]
    entry[name] = value
    bar.shell.updateEntryInline(moduleName, entry)
  }

  // The project list lives in shell.json; the tokens themselves never do. Only
  // the labels and the keyring keys under them are persisted here.
  function persistAccounts(next) {
    persistSetting("accounts", next)
  }

  // The copy menu has to offer the alias the synced config actually defines,
  // so both derive it from the label the same way.
  function prefixFor(label) {
    return Model.sshAliasFor(label)
  }

  function accountFor(label) {
    var name = String(label || "").trim()
    for (var i = 0; i < hcloud.accounts.length; i++) {
      if (hcloud.accounts[i].label === name) return hcloud.accounts[i]
    }
    return null
  }

  // Opening the form with a label already filled in is how the + on a label
  // row adds a second token to it.
  function beginAddToken(label) {
    addTokenOpen = true
    labelField.text = String(label || "")
    tokenField.text = ""
    Qt.callLater(function() {
      if (labelField.text === "") labelField.forceActiveFocus()
      else tokenField.forceActiveFocus()
    })
  }

  function submitToken() {
    if (!hcloud.addToken(labelField.text, tokenField.text)) return
    tokenField.text = ""
  }

  // Every live instance of this widget — the shell builds one per monitor.
  // The first in the shell's list polls for everyone while the panel is
  // closed; every instance walks the same list, so they agree on who that is
  // without talking to each other. An instance whose panel is open fetches
  // for itself.
  function peers() {
    if (!bar || typeof bar.moduleWidgets !== "function") return [root]
    var items = bar.moduleWidgets(moduleName) || []
    return items.length > 0 ? items : [root]
  }

  function primaryPeer() {
    return peers()[0]
  }

  function isPrimary() {
    return primaryPeer() === root
  }

  // What the primary hands a peer, and what a peer asks the primary for when
  // it arrives between two polls.
  function sharedServersRaw() {
    return hcloud.lastServersRaw
  }

  function receiveServers(raw) {
    hcloud.applyShared(raw)
  }

  function shareServers(raw) {
    var items = peers()
    for (var i = 0; i < items.length; i++) {
      var peer = items[i]
      if (peer && peer !== root && typeof peer.receiveServers === "function") peer.receiveServers(raw)
    }
  }

  // A refresh asked for from the bar or over IPC lands on whichever instance
  // owns the click or the target. With the panel shut only the primary polls,
  // so the request is handed to it; its answer comes back through shareServers.
  function requestRefresh() {
    if (opened) { hcloud.refresh(); return }
    var primary = primaryPeer()
    if (primary && primary !== root && typeof primary.pollNow === "function") { primary.pollNow(); return }
    hcloud.refresh()
  }

  function pollNow() {
    hcloud.refresh()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: {
    if (!opened) {
      // Metrics are for the row being looked at. With the panel shut there is
      // no such row, and the idle refresh must not keep asking for it.
      hcloud.clearMetrics()
      return
    }
    cursorActive = false
    query = ""
    searchRevealed = false
    detailId = ""
    hcloud.clearMetrics()
    if (panelFlick) panelFlick.contentY = 0
    view = hasLabels ? "servers" : "settings"
    focusSection = "header"
    addTokenOpen = !hasLabels
    hcloud.refreshIfStale()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }
  onVisibleRowsChanged: ensureCursor()
  onLabelsChanged: ensureCursor()
  onViewChanged: ensureCursor()

  Service {
    id: hcloud
    settings: root.settings
    panelOpen: root.opened
    primaryCheck: function() { return root.isPrimary() }
    primaryOutput: function() {
      var primary = root.primaryPeer()
      return primary && primary !== root && typeof primary.sharedServersRaw === "function"
        ? String(primary.sharedServersRaw() || "") : ""
    }
    onServersLoaded: function(raw) { root.shareServers(raw) }

    onTokenStored: function(label, key) {
      root.persistAccounts(Model.addAccountKey(hcloud.accounts, label, key))
      labelField.text = ""
      root.addTokenOpen = false
      root.leaveEditing()
    }
    onTokenRemoved: function(label) {
      root.persistAccounts(Model.removeAccount(hcloud.accounts, label))
    }
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { root.requestRefresh(); return "ok" }
    function status(): string { return root.summary }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    foreground: root.barIconColor
    tooltipText: root.barTooltip
    iconComponent: Component {
      Item {
        HetznerIcon {
          anchors.centerIn: parent
          iconSize: Style.bar.iconCanvas
          color: root.barIconColor
          fontFamily: root.fontFamily
        }
      }
    }
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton || buttonCode === Qt.MiddleButton) root.requestRefresh()
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    // 380 is what every first-party panel uses — audio, bluetooth, dropbox,
    // monitor, network, power, tailscale, agents. Only clock and weather go
    // wider, for a calendar grid and a forecast. Nothing here earns the
    // exception: the long lines elide or wrap by design, and a widget that
    // sits among the others should match them.
    contentWidth: panel.fittedContentWidth(Style.space(380))
    // The header, the message line and the search do not scroll, so the
    // panel has to be tall enough for them plus whatever the list needs.
    contentHeight: panel.fittedContentHeight(
      stickyColumn.implicitHeight + shellLayout.spacing + column.implicitHeight,
      Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.copyMenuOpen || root.editing
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        root.moveCursor(dx, dy)
      }
      onActivateRequested: if (root.cursorActive) root.activateCursor()
      onCloseRequested: {
        // Esc backs out one step at a time: a detail page, then the search,
        // then settings, then shut.
        if (root.view === "detail") root.closeDetail()
        else if (root.query !== "") root.query = ""
        else if (root.view === "settings" && root.hasLabels) root.toggleView()
        else root.close()
      }
      onDeleteRequested: if (root.focusSection === "tokens") hcloud.removeToken(root.selectedLabel())
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        var key = String(t).toLowerCase()
        if (key === "r") hcloud.refreshManually()
        else if (key === "c") root.copySelected("ipv4")
        else if (key === "n") root.copySelected("name")
        else if (key === "v") root.copySelected("ipv6")
        else if (key === "p") root.copySelected("private")
        else if (key === "s") root.copySelected("ssh")
        else if (t === "d") root.openSelectedDetail()
        else if (t === "/") root.focusSearch()
        else if (t === ",") root.toggleView()
      }

      ColumnLayout {
        id: shellLayout
        anchors.fill: parent
        spacing: Style.space(12)

        Column {
          id: stickyColumn
          Layout.fillWidth: true
          spacing: Style.space(12)

          Item {
            id: header
            width: parent.width
            implicitHeight: hero.implicitHeight
            // The hero's trailingControl resolves `root` to PanelHero, so panel
            // state has to be reached through this wrapper instead.
            readonly property bool ringVisible: root.cursorActive && root.focusSection === "header"
            readonly property color fg: root.foreground
            readonly property string family: root.fontFamily
            readonly property bool settingsActive: root.view === "settings"
            readonly property bool inDetail: root.view === "detail"
            readonly property bool canLeaveSettings: root.hasLabels
            readonly property bool refreshing: hcloud.refreshing
            readonly property string updatedAt: hcloud.lastUpdated
            function focusHeader() { root.setHeaderCursor() }
            function refreshNow() { hcloud.refreshManually() }
            function toggleSettings() { root.toggleView() }

            PanelHero {
              id: hero
              width: parent.width
              title: "Hetzner Cloud"
              meta: hcloud.refreshing && !hcloud.loaded ? "Loading…" : root.summary
              detail: root.groups.failed > 0 ? String(root.groups.failed) + " failed" : ""
              foreground: root.foreground
              fontFamily: root.fontFamily
              iconOpacity: root.healthy ? 1.0 : 0.5

              iconComponent: Component {
                HetznerIcon {
                  iconSize: Style.font.display
                  color: hero.foreground
                  fontFamily: hero.fontFamily
                }
              }

              trailingControl: Component {
                Row {
                  spacing: Style.space(2)

                  // While the bridge is out the button gives way to the same
                  // glyph, turning: a refresh that changes nothing is still
                  // seen to have happened.
                  Item {
                    width: refreshButton.width
                    height: refreshButton.height

                    PanelActionButton {
                      id: refreshButton
                      visible: !header.refreshing
                      iconText: "\udb81\udc50"
                      tooltipText: header.updatedAt === "" ? "Refresh now" : "Refresh now · data from " + header.updatedAt
                      foreground: header.fg
                      fontFamily: header.family
                      hasCursor: header.ringVisible
                      onHovered: function(on) { if (on) header.focusHeader() }
                      onClicked: header.refreshNow()
                    }

                    Text {
                      textFormat: Text.PlainText
                      visible: header.refreshing
                      anchors.centerIn: parent
                      text: "\udb81\udc50"
                      color: header.fg
                      font.family: header.family
                      font.pixelSize: refreshButton.fontSize
                      transformOrigin: Item.Center

                      RotationAnimation on rotation {
                        from: 0
                        to: 360
                        duration: 900
                        loops: Animation.Infinite
                        running: header.refreshing
                      }
                    }
                  }

                  PanelActionButton {
                    iconText: header.inDetail ? "󰅁" : "󰒓"
                    tooltipText: header.inDetail
                      ? "Back to the list"
                      : (header.settingsActive
                      ? (header.canLeaveSettings ? "Back to servers" : "Add a token to get started")
                      : "Tokens and SSH sync")
                    foreground: header.fg
                    fontFamily: header.family
                    bordered: header.settingsActive
                    onClicked: header.toggleSettings()
                  }
                }
              }
            }
          }

          Text {
            textFormat: Text.PlainText
            visible: hcloud.actionStatus !== "" || hcloud.lastError !== ""
            width: parent.width
            text: hcloud.actionStatus !== "" ? hcloud.actionStatus : hcloud.lastError
            color: hcloud.lastError !== "" && hcloud.actionStatus === "" ? root.urgent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          // ------------------------------------------------------- search
          TextField {
            id: searchField
            visible: root.showSearch && root.view === "servers"
            width: parent.width
            foreground: root.foreground
            font.family: root.fontFamily
            placeholderText: "Search servers"
            text: root.query
            onTextChanged: {
              root.query = text
              root.serverIndex = 0
            }
            Keys.onPressed: function(event) {
              if (event.key === Qt.Key_Escape) {
                if (root.query !== "") root.query = ""
                root.leaveEditing()
                event.accepted = true
                return
              }
              if (event.key === Qt.Key_Down || event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                if (root.visibleRows.length > 0) {
                  root.setServerCursor(0)
                  root.leaveEditing()
                }
                event.accepted = true
              }
            }
          }

          // The list view gets a rule from its first project group and the
          // settings view from its first section; only the detail page has
          // none of its own, so the header ran straight into the content.
          PanelSeparator {
            visible: root.view === "detail"
            width: parent.width
            foreground: root.foreground
          }
        }

        Flickable {
          id: panelFlick
          Layout.fillWidth: true
          Layout.fillHeight: true
          contentWidth: column.width
          contentHeight: column.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          flickableDirection: Flickable.VerticalFlick
          interactive: contentHeight > height
          ScrollBar.vertical: ScrollBar { id: panelScroll; policy: ScrollBar.AsNeeded }

          Column {
            id: column
            // Give the scrollbar its own lane instead of letting it sit on top of
            // the copy buttons. Reserved from implicitWidth, which is constant,
            // rather than from the bar's visibility — that would feed back into
            // the content height that decides whether it shows at all.
            width: panelFlick.width - panelScroll.implicitWidth
            spacing: Style.space(12)

            // Servers and settings are two views of one panel: the same key
            // catcher, the same cursor model, no second window to manage.
            Column {
              visible: root.view === "servers"
              width: parent.width
              spacing: Style.space(12)

              // ------------------------------------------------------- projects
              Repeater {
                model: root.groups.groups

                Column {
                  required property var modelData
                  readonly property var group: modelData
                  // A project the search emptied steps aside; one that failed
                  // to load stays, whatever the search says.
                  visible: !group.hidden
                  width: column.width
                  spacing: Style.space(8)

                  PanelSeparator {
                    width: parent.width
                    foreground: root.foreground
                  }

                  PanelSectionHeader {
                    text: String(group.label).toUpperCase()
                      + (group.ok ? "  ·  " + String(group.count) : "")
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                  }

                  ProjectErrorRow {
                    visible: !group.ok
                    width: parent.width
                    message: String(group.error)
                    httpStatus: Number(group.status)
                    stale: group.stale === true
                  }

                  Text {
                    textFormat: Text.PlainText
                    visible: group.ok && group.servers.length === 0
                    width: parent.width
                    text: group.count === 0 ? "No servers in this project." : "No servers match the search."
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    horizontalAlignment: Text.AlignHCenter
                  }

                  Column {
                    width: parent.width
                    spacing: Style.space(6)

                    Repeater {
                      model: group.servers

                      ServerRow {
                        required property var modelData
                        required property int index
                        width: parent.width
                        server: modelData
                        rowIndex: index
                      }
                    }
                  }

                  Text {
                    textFormat: Text.PlainText
                    visible: group.boxesError !== ""
                    width: parent.width
                    text: group.boxesError
                    color: root.urgent
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    wrapMode: Text.WordWrap
                  }

                  // Storage boxes belong to the project whose token reported
                  // them, so they sit under its heading rather than in a pile of
                  // their own at the bottom.
                  Column {
                    visible: group.boxes.length > 0
                    width: parent.width
                    spacing: Style.space(6)

                    Repeater {
                      model: group.boxes

                      StorageBoxRow {
                        required property var modelData
                        required property int index
                        width: parent.width
                        box: modelData
                        rowIndex: index
                      }
                    }
                  }
                }
              }

            }

            // ------------------------------------------------------- detail
            Column {
              visible: root.view === "detail"
              width: parent.width
              spacing: Style.space(10)

              // What is being looked at, stated here rather than in the hero.
              // The hero is the panel's identity; swapping it for the selection
              // makes this read as a different window and takes the fleet summary
              // away with it.
              RowLayout {
                visible: root.detailServer !== null || root.detailBox !== null
                width: parent.width
                spacing: Style.space(8)

                ColumnLayout {
                  Layout.fillWidth: true
                  spacing: Style.space(1)

                  Text {
                    textFormat: Text.PlainText
                    Layout.fillWidth: true
                    text: root.detailTitle
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.subtitle
                    font.bold: true
                    elide: Text.ElideRight
                  }

                  Text {
                    textFormat: Text.PlainText
                    Layout.fillWidth: true
                    text: {
                      var parts = []
                      if (root.detailServer) {
                        parts.push(root.detailServer.status)
                        if (root.detailServer.typeName !== "") parts.push(root.detailServer.typeName)
                        if (root.detailServer.location !== "") parts.push(root.detailServer.location)
                        parts.push(root.detailServer.project)
                      } else if (root.detailBox) {
                        if (root.detailBox.product !== "") parts.push(root.detailBox.product)
                        if (root.detailBox.location !== "") parts.push(root.detailBox.location)
                        parts.push(root.detailBox.project)
                      }
                      return parts.join("  ·  ")
                    }
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    wrapMode: Text.WordWrap
                  }
                }

                Text {
                  textFormat: Text.PlainText
                  visible: root.detailServer !== null
                  text: Model.osGlyph(root.detailServer)
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.icon
                  Layout.alignment: Qt.AlignTop
                }
              }

              Text {
                textFormat: Text.PlainText
                visible: root.detailServer === null && root.detailBox === null
                width: parent.width
                text: "That row is gone."
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                horizontalAlignment: Text.AlignHCenter
              }

              Column {
                width: parent.width
                spacing: Style.space(2)

                Repeater {
                  model: root.detailRows

                  RowLayout {
                    required property var modelData
                    width: parent.width
                    visible: modelData.gap !== true
                    height: modelData.gap === true ? Style.space(6) : implicitHeight
                    spacing: Style.space(8)

                    Text {
                      textFormat: Text.PlainText
                      text: String(modelData.key || "")
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      Layout.alignment: Qt.AlignTop
                    }

                    // The value is the copy target, the way the network panel does it —
                    // no second list underneath repeating what is already on screen.
                    Text {
                      id: detailValue
                      textFormat: Text.PlainText
                      text: String(modelData.value || "")
                      color: modelData.bad === true ? root.urgent : root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      wrapMode: Text.WrapAnywhere
                      horizontalAlignment: Text.AlignRight
                      Layout.fillWidth: true

                      MouseArea {
                        id: detailCopy
                        anchors.fill: parent
                        enabled: String(modelData.copy || "") !== ""
                        hoverEnabled: enabled
                        cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                        onClicked: hcloud.copyToClipboard(String(modelData.copy || ""))
                      }

                      PanelToolTip {
                        visible: detailCopy.enabled && detailCopy.containsMouse
                        text: "Copy to clipboard"
                        fontFamily: root.fontFamily
                      }
                    }
                  }
                }

                // A single current value with a trend is a stat tile: the number is the
                // reading, the curve only answers whether this is a spike or the usual.
                // No axes, no grid, no legend for one series — and every number the curve
                // could be asked for is printed under it, which is the substance of the
                // hover tooltip this deliberately does without.
                // The tile is on the page from the first frame, empty until the
                // curve arrives, so nothing below it moves when it does.
                Column {
                  visible: root.detailServer !== null
                  width: parent.width
                  spacing: Style.space(4)

                  RowLayout {
                    width: parent.width
                    spacing: Style.space(8)

                    Text {
                      textFormat: Text.PlainText
                      text: "CPU"
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      Layout.fillWidth: true
                    }

                    Text {
                      textFormat: Text.PlainText
                      text: root.cpuStats.count > 0 ? Model.formatPercent(root.cpuStats.current)
                        : (root.metricsPending ? "…" : "—")
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.bodySmall
                    }
                  }

                  // A little air between the reading and the curve, so the tile
                  // does not read as squeezed.
                  Item {
                    width: parent.width
                    height: Style.space(6)
                  }

                  Shape {
                    id: spark
                    width: parent.width
                    height: Style.space(38)
                    antialiasing: true

                    ShapePath {
                      fillColor: "transparent"
                      strokeColor: root.accent
                      // 2px, round join and cap: the mark spec for a line.
                      strokeWidth: Math.max(1, Style.space(2))
                      capStyle: ShapePath.RoundCap
                      joinStyle: ShapePath.RoundJoin

                      PathPolyline { path: root.sparkPath }
                    }
                  }

                  RowLayout {
                    width: parent.width
                    spacing: Style.space(6)

                    // A failed metrics call used to leave the page looking as if
                    // the server simply had no live figures. It is said here, in
                    // the line the figures would otherwise take.
                    Text {
                      textFormat: Text.PlainText
                      text: {
                        if (hcloud.metricsError !== "" && root.cpuStats.count === 0) return hcloud.metricsError
                        if (root.cpuStats.count === 0) return root.metricsPending ? "Loading…" : "No CPU history for this window"
                        return "peak " + Model.formatPercent(root.cpuStats.peak)
                          + "  ·  avg " + Model.formatPercent(root.cpuStats.average)
                      }
                      color: hcloud.metricsError !== "" && root.cpuStats.count === 0 ? root.urgent : root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      elide: Text.ElideRight
                      Layout.fillWidth: true
                    }

                    Repeater {
                      model: [3600, 86400, 604800]

                      Button {
                        required property var modelData
                        text: Model.windowLabel(modelData)
                        selected: hcloud.metricsWindow === modelData
                        foreground: root.foreground
                        fontFamily: root.fontFamily
                        fontSize: Style.font.caption
                        horizontalPadding: Style.spacing.sm
                        verticalPadding: Style.spacing.xxs
                        onClicked: hcloud.setMetricsWindow(modelData)
                      }
                    }
                  }
                }

              }
            }

            Column {
              visible: root.view === "settings"
              width: parent.width
              spacing: Style.space(12)

              // ------------------------------------------------------- setup
              Column {
                visible: !root.hasLabels
                width: parent.width
                spacing: Style.space(8)

                Text {
                  textFormat: Text.PlainText
                  width: parent.width
                  text: "Hetzner Cloud API tokens are scoped to a single project, and the API has no way to list your projects. Add one read-only token per project, each with a label you choose."
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  wrapMode: Text.WordWrap
                }

                Text {
                  textFormat: Text.PlainText
                  width: parent.width
                  text: "Hetzner Cloud Console → Security → API tokens → Generate, with Read permission."
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  wrapMode: Text.WordWrap
                }
              }

              // ------------------------------------------------------- tokens
              PanelSeparator {
                width: parent.width
                foreground: root.foreground
              }

              Column {
                width: parent.width
                spacing: Style.space(6)

                PanelSectionHeader {
                  text: "PROJECT TOKENS"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                }

                Repeater {
                  model: root.labels

                  TokenRow {
                    required property var modelData
                    required property int index
                    width: parent.width
                    label: String(modelData)
                    rowIndex: index
                  }
                }

                CursorSurface {
                  id: addRow
                  visible: !root.addTokenOpen
                  width: parent.width
                  foreground: root.foreground
                  fill: root.hoverFill
                  implicitHeight: addRowText.implicitHeight + Style.spacing.xl

                  MouseArea {
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.beginAddToken("")
                  }

                  Text {
                    id: addRowText
                    textFormat: Text.PlainText
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.leftMargin: Style.space(10)
                    anchors.rightMargin: Style.space(10)
                    text: "+  Add a project token"
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    elide: Text.ElideRight
                  }
                }

                // A card rather than four loose controls, so it reads as one thing being
                // filled in rather than a pile of fields.
                BorderSurface {
                  visible: root.addTokenOpen
                  width: parent.width
                  implicitHeight: addForm.implicitHeight + Style.space(20)
                  color: root.hoverFill
                  radius: Style.cornerRadius
                  // Tinted rather than outlined. An outline here weighed as much as
                  // the rows above it and flattened the difference between the list
                  // and the form sitting inside it.
                  borderSpec: Border.none()

                  Column {
                    id: addForm
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.leftMargin: Style.space(12)
                    anchors.rightMargin: Style.space(12)
                    spacing: Style.space(10)

                    Column {
                      width: parent.width
                      spacing: Style.space(3)

                      TextField {
                        id: labelField
                        width: parent.width
                        foreground: root.foreground
                        font.family: root.fontFamily
                        placeholderText: "Project label, e.g. production"
                        onAccepted: tokenField.forceActiveFocus()
                        Keys.onPressed: function(event) {
                          if (event.key === Qt.Key_Escape) {
                            root.addTokenOpen = !root.hasLabels
                            root.leaveEditing()
                            event.accepted = true
                          }
                        }
                      }

                      // Say which of the two things this is about to do, before it does it.
                      Text {
                        textFormat: Text.PlainText
                        width: parent.width
                        text: {
                          var typed = labelField.text.trim()
                          if (typed === "") return "Servers from this token appear under this heading."
                          var existing = root.accountFor(typed)
                          if (!existing) return "A new heading — its servers get a group of their own."
                          return "Adds a " + (existing.keys.length === 1 ? "second" : "further")
                            + " token to " + typed + ", and both projects' servers appear together."
                        }
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        wrapMode: Text.WordWrap
                      }
                    }

                    Column {
                      width: parent.width
                      spacing: Style.space(3)

                      TextField {
                        id: tokenField
                        width: parent.width
                        foreground: root.foreground
                        font.family: root.fontFamily
                        password: true
                        placeholderText: "Hetzner API token, read permission"
                        onAccepted: root.submitToken()
                        Keys.onPressed: function(event) {
                          if (event.key === Qt.Key_Escape) {
                            text = ""
                            root.addTokenOpen = !root.hasLabels
                            root.leaveEditing()
                            event.accepted = true
                          }
                        }
                      }

                      Text {
                        textFormat: Text.PlainText
                        width: parent.width
                        text: "Console → Security → API tokens. Kept in the login keyring."
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        wrapMode: Text.WordWrap
                      }
                    }

                    Row {
                      spacing: Style.space(8)

                      Button {
                        text: "Save token"
                        foreground: root.foreground
                        fontFamily: root.fontFamily
                        bordered: true
                        enabled: !hcloud.busy && labelField.text.trim() !== "" && tokenField.text !== ""
                        onClicked: root.submitToken()
                      }

                      Button {
                        visible: root.hasLabels
                        text: "Cancel"
                        foreground: root.dim
                        fontFamily: root.fontFamily
                        onClicked: {
                          tokenField.text = ""
                          root.addTokenOpen = false
                          root.leaveEditing()
                        }
                      }
                    }
                  }
                }
              }

              // ------------------------------------------------------- ssh sync
              PanelSeparator {
                width: parent.width
                foreground: root.foreground
              }

              Column {
                width: parent.width
                spacing: Style.space(6)

                PanelSectionHeader {
                  text: "SSH CONFIG"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                }

                Toggle {
                  width: parent.width
                  label: "Sync ~/.ssh/config"
                  description: hcloud.syncStatusText
                  checked: hcloud.syncSshConfig
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  onClicked: root.persistSetting("syncSshConfig", !hcloud.syncSshConfig)
                }

                Text {
                  textFormat: Text.PlainText
                  visible: hcloud.syncSshConfig
                  width: parent.width
                  text: "One Host entry per server, between the hcloud-sync markers, as "
                    + hcloud.sshUser + " with "
                    + (hcloud.sshKey === "" ? "no identity file" : hcloud.sshKey)
                    + ". Each host is named <label>/<server>, as shown on the token rows above. The rest of "
                    + "the file is left alone, and the previous version is kept as config.hcloud-sync.bak."
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  wrapMode: Text.WordWrap
                }
              }

              // ------------------------------------------------------- refresh
              PanelSeparator {
                width: parent.width
                foreground: root.foreground
              }

              Column {
                width: parent.width
                spacing: Style.space(6)

                PanelSectionHeader {
                  text: "REFRESH"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                }

                Row {
                  spacing: Style.space(4)

                  Repeater {
                    model: [60, 300, 900, 3600]

                    Button {
                      required property var modelData
                      text: Model.intervalLabel(modelData)
                      selected: hcloud.refreshIntervalSec === modelData
                      bordered: true
                      foreground: root.foreground
                      fontFamily: root.fontFamily
                      fontSize: Style.font.caption
                      horizontalPadding: Style.spacing.sm
                      verticalPadding: Style.spacing.xxs
                      onClicked: root.persistSetting("refreshIntervalSec", modelData)
                    }
                  }
                }

                Text {
                  textFormat: Text.PlainText
                  width: parent.width
                  text: "Polled every " + Model.intervalLabel(hcloud.refreshIntervalSec)
                    + " while the panel is open and every "
                    + Model.intervalLabel(Math.max(hcloud.refreshIntervalSec, hcloud.idleIntervalSec))
                    + " while it is closed. Opening the panel only fetches when the list is older "
                    + "than that. Other values: refreshIntervalSec and idleIntervalSec in shell.json."
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  wrapMode: Text.WordWrap
                }
              }
            }
          }
        }
      }
    }
  }

  // ----------------------------------------------------------- components

  component ProjectErrorRow: CursorSurface {
    id: errorRow
    property string message: ""
    property int httpStatus: 0
    property bool stale: false

    readonly property string hint: {
      var kept = stale ? "Showing the last list that loaded. " : ""
      if (httpStatus === 401 || httpStatus === 403) return kept + "Remove the token below and add a fresh one."
      if (httpStatus === 429) return kept + "Hetzner is rate limiting — raise the refresh interval."
      if (httpStatus === 0) return kept + "Check the network, then refresh."
      return kept.trim()
    }

    foreground: root.foreground
    implicitHeight: errorInner.implicitHeight + Style.spacing.xl

    Row {
      id: errorInner
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(8)

      Text {
        textFormat: Text.PlainText
        text: "󰀨"
        color: root.urgent
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        width: Style.space(22)
        horizontalAlignment: Text.AlignHCenter
        anchors.verticalCenter: parent.verticalCenter
      }

      Column {
        width: parent.width - Style.space(30)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(1)

        Text {
          textFormat: Text.PlainText
          width: parent.width
          text: errorRow.message
          color: root.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        Text {
          textFormat: Text.PlainText
          visible: errorRow.hint !== ""
          width: parent.width
          text: errorRow.hint
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }
      }
    }
  }

  // One copy menu for both kinds of row. It owns its own cursor, so a row only
  // has to say what it offers and what to do with the choice.
  component CopyMenu: Popup {
    id: menu
    property var options: []
    property int index: 0
    property Item anchorButton: null
    signal chosen(string kind)

    x: anchorButton ? anchorButton.x + anchorButton.width - width : 0
    y: anchorButton ? anchorButton.y + anchorButton.height + Style.space(4) : 0
    width: Style.space(300)
    padding: 0
    modal: false
    focus: true
    closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside

    function clampIndex() {
      index = Math.max(0, Math.min(index, options.length - 1))
    }

    function show() {
      if (options.length === 0) return
      clampIndex()
      open()
    }

    function move(delta) {
      if (options.length === 0) return
      index = Math.max(0, Math.min(options.length - 1, index + delta))
    }

    function pick(kind) {
      chosen(String(kind || ""))
      close()
    }

    function pickCurrent() {
      clampIndex()
      if (options.length === 0) return
      pick(options[index].kind)
    }

    function handleKey(event) {
      if (event.key === Qt.Key_Escape) {
        close()
        event.accepted = true
        return
      }
      if (event.key === Qt.Key_Down || event.text === "j") {
        move(1)
        event.accepted = true
        return
      }
      if (event.key === Qt.Key_Up || event.text === "k") {
        move(-1)
        event.accepted = true
        return
      }
      if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter || event.key === Qt.Key_Space) {
        pickCurrent()
        event.accepted = true
      }
    }

    onOpenedChanged: {
      root.copyMenuOpen = opened
      if (opened) {
        clampIndex()
        Qt.callLater(function() { copyMenuContent.forceActiveFocus() })
      } else if (root.opened) {
        Qt.callLater(function() { keyCatcher.forceActiveFocus() })
      }
    }

    background: BorderSurface {
      color: Color.background
      borderSpec: Border.flat(root.dim, 1)
      radius: Style.cornerRadius
    }

    contentItem: Column {
      id: copyMenuContent
      width: parent.width
      focus: true
      Keys.priority: Keys.BeforeItem
      Keys.onPressed: function(event) { menu.handleKey(event) }

      Repeater {
        model: menu.options

        CopyChoice {
          required property var modelData
          required property int index
          width: parent.width
          label: String(modelData.label || "")
          selected: menu.index === index
          onHovered: menu.index = index
          onChosen: menu.pick(String(modelData.kind || ""))
        }
      }
    }
  }

  // A small disc before the name. Filled when the machine runs, hollow when it
  // is off, breathing through a transition, urgent for anything else; the
  // tooltip says the word. A shape at a fixed x is what makes the column
  // scannable, and hollow-versus-filled survives any theme's palette.
  component StateDot: Item {
    id: stateDot
    property string tone: "bad"
    property string label: ""
    readonly property color toneColor: root.toneColor(tone)
    readonly property bool filled: tone === "live" || tone === "bad"

    implicitWidth: Style.space(12)
    implicitHeight: Style.space(12)

    Rectangle {
      id: disc
      anchors.centerIn: parent
      width: Style.space(8)
      height: Style.space(8)
      radius: width / 2
      color: stateDot.filled ? stateDot.toneColor : "transparent"
      border.color: stateDot.toneColor
      border.width: Style.space(1)

      SequentialAnimation on opacity {
        running: stateDot.tone === "busy"
        loops: Animation.Infinite
        NumberAnimation { to: 0.3; duration: 650; easing.type: Easing.InOutSine }
        NumberAnimation { to: 1.0; duration: 650; easing.type: Easing.InOutSine }
      }

      onOpacityChanged: if (stateDot.tone !== "busy" && opacity !== 1.0) opacity = 1.0
    }

    // A handler rather than a MouseArea, so the row underneath keeps its hover.
    HoverHandler {
      id: dotHover
    }

    PanelToolTip {
      visible: dotHover.hovered && stateDot.label !== ""
      text: stateDot.label
      fontFamily: root.fontFamily
    }
  }

  component ServerRow: CursorSurface {
    id: serverRow
    property var server: null
    property int rowIndex: 0

    // The panel-wide cursor index, so j/k walks across project boundaries.
    readonly property int globalIndex: {
      var groups = root.groups.groups
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].label === (server ? server.project : "")) return groups[i].offset + rowIndex
      }
      return rowIndex
    }
    readonly property string prefix: server ? root.prefixFor(server.project) : ""
    readonly property var copyOptions: Model.copyOptions(server, prefix)
    readonly property string statusText: server ? server.status : ""
    readonly property bool transitional: server ? Model.isTransitional(server.status) : false

    hasCursor: root.cursorActive && root.focusSection === "servers" && root.serverIndex === globalIndex
    foreground: root.foreground
    fill: root.hoverFill

    implicitHeight: rowStack.implicitHeight + Style.spacing.rowPaddingX

    Component.onCompleted: if (server) root.registerServerRow(root.rowKey(server), serverRow)
    Component.onDestruction: if (server) root.registerServerRow(root.rowKey(server), null)
    onHasCursorChanged: if (hasCursor) root.scrollItemIntoView(serverRow)

    function openCopyMenu() {
      copyMenu.show()
    }

    MouseArea {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      height: Math.min(parent.height, summary.implicitHeight + Style.spacing.rowPaddingX)
      acceptedButtons: Qt.LeftButton
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onContainsMouseChanged: if (containsMouse) root.setServerCursor(serverRow.globalIndex)
      onClicked: if (serverRow.server && serverRow.server.ipv4 !== "") hcloud.copyToClipboard(serverRow.server.ipv4)
    }

    Column {
      id: rowStack
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(8)
      spacing: Style.space(6)

      RowLayout {
        id: summary
        width: parent.width
        spacing: Style.space(8)

        StateDot {
          tone: serverRow.server ? serverRow.server.tone : "bad"
          label: serverRow.statusText + (serverRow.server && serverRow.server.locked ? " · locked" : "")
          Layout.alignment: Qt.AlignVCenter
        }

        ColumnLayout {
          id: serverContent
          Layout.fillWidth: true
          spacing: Style.space(1)

          RowLayout {
            Layout.fillWidth: true
            spacing: Style.space(6)

            Text {
              textFormat: Text.PlainText
              Layout.fillWidth: true
              text: serverRow.server ? serverRow.server.name : ""
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              elide: Text.ElideRight
            }

            Text {
              textFormat: Text.PlainText
              visible: serverRow.server && serverRow.server.locked
              text: "󰌾"
              color: root.urgent
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              Layout.alignment: Qt.AlignVCenter
            }

            // A running machine says nothing beyond its dot; anything else
            // says what it is doing, in the tone's colour.
            Text {
              id: statusWord
              textFormat: Text.PlainText
              visible: serverRow.statusText !== "running"
              text: serverRow.statusText
              color: root.toneColor(serverRow.server ? serverRow.server.tone : "bad")
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              Layout.alignment: Qt.AlignVCenter
            }
          }

          Text {
            textFormat: Text.PlainText
            Layout.fillWidth: true
            text: Model.serverMeta(serverRow.server)
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }

        // What it runs, at the trailing edge. Its position is set by what
        // stands to its right, so it lands at the same x on every row while
        // the variable-width status word floats to its left.
        Text {
          textFormat: Text.PlainText
          text: Model.osGlyph(serverRow.server)
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.icon
          Layout.alignment: Qt.AlignVCenter
        }

        // Keeps an informational glyph out of the button cluster, so it does
        // not read as something to press.
        Item {
          Layout.preferredWidth: Style.space(4)
          Layout.preferredHeight: 1
        }

        // Copy and chevron are one cluster, set tight; the gap before them is
        // what keeps the distro mark from reading as a third button.
        RowLayout {
          spacing: Style.space(2)
          Layout.alignment: Qt.AlignVCenter

          PanelActionButton {
            id: copyButton
            iconText: "󰆏"
            tooltipText: "Copy…"
            foreground: root.foreground
            fontFamily: root.fontFamily
            enabled: serverRow.copyOptions.length > 0
            Layout.alignment: Qt.AlignVCenter
            onClicked: serverRow.openCopyMenu()
          }

          CopyMenu {
            id: copyMenu
            anchorButton: copyButton
            options: serverRow.copyOptions
            onChosen: function(kind) {
              hcloud.copyToClipboard(Model.copyValue(serverRow.server, kind, serverRow.prefix))
            }
          }

          PanelActionButton {
            id: detailButton
            iconText: "󰅂"
            tooltipText: "Everything about this server"
            foreground: root.foreground
            fontFamily: root.fontFamily
            Layout.alignment: Qt.AlignVCenter
            onClicked: {
              root.setServerCursor(serverRow.globalIndex)
              root.openSelectedDetail()
            }
          }
        }
      }
    }
  }

  component CopyChoice: CursorSurface {
    id: copyChoice
    signal chosen()
    signal hovered()
    property string label: ""
    property bool selected: false

    visible: enabled
    foreground: root.foreground
    hasCursor: selected
    implicitHeight: Style.space(44)
    radius: 0

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: copyChoice.hovered()
      onClicked: copyChoice.chosen()
    }

    RowLayout {
      anchors.fill: parent
      anchors.leftMargin: Style.space(12)
      anchors.rightMargin: Style.space(12)
      spacing: Style.space(10)

      Text {
        textFormat: Text.PlainText
        Layout.fillWidth: true
        text: copyChoice.label
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        elide: Text.ElideRight
      }

      Text {
        textFormat: Text.PlainText
        text: "󰆏"
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.icon
        Layout.alignment: Qt.AlignVCenter
      }
    }
  }

  // The same row as a server's: name with a grey line under it, a mark for
  // what it is at the trailing edge, then copy and chevron. Same cursor, same
  // hover, same keys — it is one list.
  component StorageBoxRow: CursorSurface {
    id: boxRow
    property var box: null
    property int rowIndex: 0

    // Boxes follow their project's servers in the cursor order.
    readonly property int globalIndex: {
      var groups = root.groups.groups
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].label === (box ? box.project : "")) return groups[i].offset + groups[i].servers.length + rowIndex
      }
      return rowIndex
    }
    readonly property var copyOptions: Model.copyOptions(box, "")
    readonly property string usage: Model.storageBoxUsageText(box)
    readonly property string boxTone: Model.storageBoxTone(box)
    readonly property color tone: root.toneColor(boxTone)

    hasCursor: root.cursorActive && root.focusSection === "servers" && root.serverIndex === globalIndex
    foreground: root.foreground
    fill: root.hoverFill

    implicitHeight: boxStack.implicitHeight + Style.spacing.rowPaddingX

    Component.onCompleted: if (box) root.registerServerRow(root.rowKey(box), boxRow)
    Component.onDestruction: if (box) root.registerServerRow(root.rowKey(box), null)
    onHasCursorChanged: if (hasCursor) root.scrollItemIntoView(boxRow)

    function openCopyMenu() {
      boxCopyMenu.show()
    }

    // Clicking copies the host you would actually ssh to, as a server row
    // copies its IPv4.
    MouseArea {
      anchors.fill: parent
      acceptedButtons: Qt.LeftButton
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onContainsMouseChanged: if (containsMouse) root.setServerCursor(boxRow.globalIndex)
      onClicked: if (boxRow.box && boxRow.box.host !== "") hcloud.copyToClipboard(boxRow.box.host)
    }

    Column {
      id: boxStack
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(8)
      spacing: Style.space(4)

      RowLayout {
        id: boxSummary
        width: parent.width
        spacing: Style.space(8)

        StateDot {
          tone: boxRow.boxTone
          label: boxRow.box ? boxRow.box.status + (boxRow.usage !== "" ? " · " + boxRow.usage : "") : ""
          Layout.alignment: Qt.AlignVCenter
        }

        ColumnLayout {
          Layout.fillWidth: true
          spacing: Style.space(1)

          RowLayout {
            Layout.fillWidth: true
            spacing: Style.space(6)

            Text {
              textFormat: Text.PlainText
              Layout.fillWidth: true
              text: boxRow.box ? boxRow.box.name : ""
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              elide: Text.ElideRight
            }

            Text {
              textFormat: Text.PlainText
              visible: boxRow.usage !== ""
              text: boxRow.usage
              color: boxRow.tone
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              Layout.alignment: Qt.AlignVCenter
            }
          }

          Text {
            textFormat: Text.PlainText
            Layout.fillWidth: true
            text: Model.storageBoxMeta(boxRow.box)
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }

        // What it is, where a server row says what it runs.
        Text {
          textFormat: Text.PlainText
          text: "\udb80\udeca"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.icon
          Layout.alignment: Qt.AlignVCenter
        }

        Item {
          Layout.preferredWidth: Style.space(4)
          Layout.preferredHeight: 1
        }

        RowLayout {
          spacing: Style.space(2)
          Layout.alignment: Qt.AlignVCenter

          PanelActionButton {
            id: boxCopyButton
            iconText: "󰆏"
            tooltipText: "Copy…"
            foreground: root.foreground
            fontFamily: root.fontFamily
            enabled: boxRow.copyOptions.length > 0
            Layout.alignment: Qt.AlignVCenter
            onClicked: boxRow.openCopyMenu()
          }

          CopyMenu {
            id: boxCopyMenu
            anchorButton: boxCopyButton
            options: boxRow.copyOptions
            onChosen: function(kind) {
              hcloud.copyToClipboard(Model.copyValue(boxRow.box, kind, ""))
            }
          }

          PanelActionButton {
            id: boxDetailButton
            iconText: "󰅂"
            tooltipText: "Everything about this box"
            foreground: root.foreground
            fontFamily: root.fontFamily
            Layout.alignment: Qt.AlignVCenter
            onClicked: {
              root.setServerCursor(boxRow.globalIndex)
              root.openSelectedDetail()
            }
          }
        }
      }

      // The one thing a cloud server cannot tell us: how full it actually is.
      Rectangle {
        width: parent.width
        height: Style.space(3)
        radius: height / 2
        color: root.hoverFill

        Rectangle {
          width: parent.width * Math.max(0, Math.min(1, (boxRow.box ? boxRow.box.percent : 0) / 100))
          height: parent.height
          radius: parent.radius
          color: boxRow.tone

          Behavior on width {
            NumberAnimation { duration: 220; easing.type: Easing.OutQuad }
          }
        }
      }
    }
  }

  component TokenRow: CursorSurface {
    id: tokenRow
    property string label: ""
    property int rowIndex: 0

    readonly property var group: {
      var groups = root.groups.groups
      for (var i = 0; i < groups.length; i++) if (groups[i].label === label) return groups[i]
      return null
    }
    readonly property var account: root.accountFor(label)
    readonly property int tokenCount: account ? account.keys.length : 1
    readonly property bool failed: group !== null && !group.ok
    readonly property string stateText: {
      if (!hcloud.loaded) return "Checking…"
      if (!group) return "Not loaded yet"
      var counted = String(group.count) + (group.count === 1 ? " server" : " servers")
      if (tokenCount > 1) counted = String(tokenCount) + " tokens · " + counted
      // A label can be part loaded: one of its tokens works, another does not.
      if (!group.ok) return group.count > 0 ? counted + " · " + group.error : group.error
      return counted
    }

    hasCursor: root.cursorActive && root.focusSection === "tokens" && root.tokenIndex === rowIndex
    foreground: root.foreground
    fill: root.hoverFill

    implicitHeight: tokenStack.implicitHeight + Style.spacing.lg

    onHasCursorChanged: if (hasCursor) root.scrollItemIntoView(tokenRow)

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.ArrowCursor
      onContainsMouseChanged: if (containsMouse) root.setTokenCursor(tokenRow.rowIndex)
    }

    Column {
      id: tokenStack
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(8)
      spacing: Style.space(2)

      RowLayout {
        width: parent.width
        spacing: Style.space(8)

        Text {
          textFormat: Text.PlainText
          Layout.fillWidth: true
          text: tokenRow.label
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
        }

        PanelActionButton {
          iconText: "+"
          tooltipText: "Add another project token under " + tokenRow.label
          foreground: root.foreground
          fontFamily: root.fontFamily
          enabled: !hcloud.busy
          Layout.alignment: Qt.AlignVCenter
          onClicked: root.beginAddToken(tokenRow.label)
        }

        PanelActionButton {
          iconText: "󰅙"
          tooltipText: tokenRow.tokenCount > 1
            ? "Remove this label and all " + tokenRow.tokenCount + " of its tokens"
            : "Remove this token"
          foreground: root.foreground
          hoverColor: root.urgent
          fontFamily: root.fontFamily
          enabled: !hcloud.busy
          Layout.alignment: Qt.AlignVCenter
          onClicked: hcloud.removeToken(tokenRow.label)
        }
      }

      RowLayout {
        width: parent.width
        spacing: Style.space(8)

        Text {
          textFormat: Text.PlainText
          text: tokenRow.stateText
          color: tokenRow.failed ? root.urgent : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
          Layout.fillWidth: true
        }

        // What the sync will call this project's hosts, derived from the
        // label rather than asked for a second time.
        Text {
          textFormat: Text.PlainText
          visible: hcloud.syncSshConfig
          text: "ssh " + Model.sshAliasFor(tokenRow.label) + "/<server>"
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }
    }
  }


}
