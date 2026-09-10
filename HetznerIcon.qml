import QtQuick
import QtQuick.Effects
import qs.Commons

// The Hetzner mark: a filled disc with the H knocked out of it, so the counter
// is genuinely transparent and whatever is behind the bar shows through.
//
// Rendered from an SVG through Image rather than rebuilt with QtQuick.Shapes.
// That is not cosmetic. The shape renderer antialiases along extruded edge
// geometry and loses a two pixel counter at bar size; Image rasterises the SVG
// well above the drawn size and area-averages it down, which holds the same
// geometry cleanly. Three attempts at the shape route all failed on exactly
// that difference.
//
// The symbolic file is white on transparent and gets tinted to the caller's
// colour, the way the shell recolours -symbolic tray icons.
Item {
  id: root

  property real iconSize: Style.font.icon
  property color color: Color.foreground
  property string fontFamily: Style.font.family
  property bool dimmed: false

  width: iconSize
  height: iconSize
  implicitWidth: iconSize
  implicitHeight: iconSize
  opacity: dimmed ? 0.45 : 1.0

  Image {
    id: mark
    anchors.fill: parent
    source: Qt.resolvedUrl("assets/hetzner-symbolic.svg")
    // Rasterise well above the drawn size. Left to itself Qt renders an SVG at
    // its intrinsic size and scales the result, which is what makes small ones
    // look soft, and the counter of the H has no margin to spare.
    sourceSize.width: Math.max(1, Math.round(root.iconSize * 4))
    sourceSize.height: Math.max(1, Math.round(root.iconSize * 4))
    fillMode: Image.PreserveAspectFit
    smooth: true
    // The art is only ever drawn through the tint below.
    visible: false
    layer.enabled: true
    layer.smooth: true
    // A layer's texture is the item's size in logical pixels by default, so on
    // a scaled display it gets stretched up and the disc edge goes soft. Give
    // it enough texels for any scale factor this might land on.
    layer.textureSize: Qt.size(Math.round(width * 3), Math.round(height * 3))
  }

  MultiEffect {
    anchors.fill: mark
    source: mark
    colorization: 1.0
    colorizationColor: root.color
  }

  Text {
    // A missing asset should leave a widget you can still click, not a gap.
    anchors.centerIn: parent
    visible: mark.status !== Image.Ready
    text: "󰅟"
    color: root.color
    font.family: root.fontFamily
    font.pixelSize: root.iconSize
  }
}
