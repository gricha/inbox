import CoreText
import SwiftUI
import UIKit

// The window's default theme, its light and dark token sets exactly (web/src/styles.css, docs/visual.md): the system picks.
enum Theme {
  static let paper = Color(light: 0xeeecf3, dark: 0x0b0911)  // the canvas: a section heading, an opened item
  static let sheet = Color(light: 0xfaf9fc, dark: 0x120f1a)  // a list, a bubble, a field
  static let wash = Color(light: 0xe6e3ee, dark: 0x1c1827)
  static let side = Color(light: 0xe9e6f0, dark: 0x07060b)  // the chrome: the page's bar and its filter
  static let ink = Color(light: 0x221f2b, dark: 0xeeebf4)
  static let ink2 = Color(light: 0x3f3a4c, dark: 0xcdc7da)
  static let pencil = Color(light: 0x5c5570, dark: 0xaca4bd)
  static let faint = Color(light: 0x9a94aa, dark: 0x6f6782)
  static let rule = Color(light: 0xdcd8e5, dark: 0x2a2437)
  static let ruleStrong = Color(light: 0xc8c3d4, dark: 0x383048)
  static let red = Color(light: 0xb42318, dark: 0xffb4ab)
  // A line of a diff that was added or removed: green or red let into the sheet, faint enough to read code on.
  static let addWash = Color(light: 0xe4eeeb, dark: 0x151e1d)
  static let delWash = Color(light: 0xf6e8ea, dark: 0x2a141e)
  static let amber = Color(light: 0x8a4b08, dark: 0xebc076)
  static let green = Color(light: 0x176847, dark: 0x8dceaf)
  static let onGo = Color(light: 0xffffff, dark: 0x0e2419)  // on a button filled green (--go): Approve, Hand off for merge
  static let accent = Color(light: 0x6a3dbd, dark: 0xc4a7f5)
  static let onAccent = Color(light: 0xffffff, dark: 0x1f1336)
  static let accentInk = Color(light: 0x6236b3, dark: 0xbfa2f2)
  static let accentWash = Color(light: 0xe7defa, dark: 0x261d3a)
  static let pill = Color(light: 0x7d4ed8, dark: 0x874ad1)  // --chrome-pill: the Inbox's count, white on it
  // A swipe action's label is white whatever the appearance, so its fill stays dark in both: the light accent, and a grey.
  static let swipeAccent = Color(light: 0x6a3dbd, dark: 0x6a3dbd)
  static let swipeQuiet = Color(light: 0x5c5570, dark: 0x383048)

  static let pad: CGFloat = 16  // a row's side padding, as the two-line row's
}

extension UIColor {
  convenience init(hex: UInt32) {
    self.init(
      red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
  }
}

extension Color {
  init(light: UInt32, dark: UInt32) {
    self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
  }
}

// The system's faces, as the window's (SF Pro, SF Mono). A weight is CSS's, put on SF's weight axis, so 450, 550 and
// 650 are real.
enum Typeface {
  case sans, mono

  func font(_ size: CGFloat, weight: CGFloat = 400, tabular: Bool = false) -> UIFont {
    let base = self == .sans ? UIFont.systemFont(ofSize: size) : UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
    let weightAxis = 0x7767_6874  // 'wght'
    var attributes: [UIFontDescriptor.AttributeName: Any] = [
      UIFontDescriptor.AttributeName(rawValue: kCTFontVariationAttribute as String): [weightAxis: weight]
    ]
    if tabular { attributes[.featureSettings] = [[UIFontDescriptor.FeatureKey.type: kNumberSpacingType, .selector: kMonospacedNumbersSelector]] }
    return UIFont(descriptor: base.fontDescriptor.addingAttributes(attributes), size: size)
  }
}

// The window's sizes (14 a row's title, 12.5 its facts) as the default, scaling with Dynamic Type.
private struct Typo: ViewModifier {
  @ScaledMetric private var size: CGFloat
  let face: Typeface
  let weight: CGFloat
  let tabular: Bool
  let tracking: CGFloat  // in em

  init(face: Typeface, size: CGFloat, weight: CGFloat, tabular: Bool, tracking: CGFloat) {
    _size = ScaledMetric(wrappedValue: size, relativeTo: .body)
    self.face = face
    self.weight = weight
    self.tabular = tabular
    self.tracking = tracking
  }

  func body(content: Content) -> some View {
    content.font(Font(face.font(size, weight: weight, tabular: tabular))).tracking(tracking * size)
  }
}

extension View {
  func sans(_ size: CGFloat, _ weight: CGFloat = 400, tabular: Bool = false, tracking: CGFloat = 0) -> some View {
    modifier(Typo(face: .sans, size: size, weight: weight, tabular: tabular, tracking: tracking))
  }

  func mono(_ size: CGFloat, _ weight: CGFloat = 400) -> some View {
    modifier(Typo(face: .mono, size: size, weight: weight, tabular: false, tracking: 0))
  }
}

// The mark: assets/brand/mark.svg's two paths in its own 64×64 box (a pill above a tray). One geometry: never redrawn.
struct Mark: Shape {
  func path(in rect: CGRect) -> Path {
    var p = Path()
    // M22 19.6H42C43.6 19.6 44.9 20.9 44.9 22.5S43.6 25.4 42 25.4H22C20.4 25.4 19.1 24.1 19.1 22.5S20.4 19.6 22 19.6Z
    p.move(to: .init(x: 22, y: 19.6))
    p.addLine(to: .init(x: 42, y: 19.6))
    p.addCurve(to: .init(x: 44.9, y: 22.5), control1: .init(x: 43.6, y: 19.6), control2: .init(x: 44.9, y: 20.9))
    p.addCurve(to: .init(x: 42, y: 25.4), control1: .init(x: 44.9, y: 24.1), control2: .init(x: 43.6, y: 25.4))
    p.addLine(to: .init(x: 22, y: 25.4))
    p.addCurve(to: .init(x: 19.1, y: 22.5), control1: .init(x: 20.4, y: 25.4), control2: .init(x: 19.1, y: 24.1))
    p.addCurve(to: .init(x: 22, y: 19.6), control1: .init(x: 19.1, y: 20.9), control2: .init(x: 20.4, y: 19.6))
    p.closeSubpath()
    // M11.5 25.4H13.9C15.4 25.4 16.5 26.1 17.2 27.5L20 32.8C20.7 34.2 21.9 35 23.5 35H40.5C42.1 35 43.3 34.2 44 32.8
    // L46.8 27.5C47.5 26.1 48.6 25.4 50.1 25.4H52.5C54.4 25.4 56 27 56 28.9V37.4C56 41.3 52.8 44.5 48.9 44.5H15.1
    // C11.2 44.5 8 41.3 8 37.4V28.9C8 27 9.6 25.4 11.5 25.4Z
    p.move(to: .init(x: 11.5, y: 25.4))
    p.addLine(to: .init(x: 13.9, y: 25.4))
    p.addCurve(to: .init(x: 17.2, y: 27.5), control1: .init(x: 15.4, y: 25.4), control2: .init(x: 16.5, y: 26.1))
    p.addLine(to: .init(x: 20, y: 32.8))
    p.addCurve(to: .init(x: 23.5, y: 35), control1: .init(x: 20.7, y: 34.2), control2: .init(x: 21.9, y: 35))
    p.addLine(to: .init(x: 40.5, y: 35))
    p.addCurve(to: .init(x: 44, y: 32.8), control1: .init(x: 42.1, y: 35), control2: .init(x: 43.3, y: 34.2))
    p.addLine(to: .init(x: 46.8, y: 27.5))
    p.addCurve(to: .init(x: 50.1, y: 25.4), control1: .init(x: 47.5, y: 26.1), control2: .init(x: 48.6, y: 25.4))
    p.addLine(to: .init(x: 52.5, y: 25.4))
    p.addCurve(to: .init(x: 56, y: 28.9), control1: .init(x: 54.4, y: 25.4), control2: .init(x: 56, y: 27))
    p.addLine(to: .init(x: 56, y: 37.4))
    p.addCurve(to: .init(x: 48.9, y: 44.5), control1: .init(x: 56, y: 41.3), control2: .init(x: 52.8, y: 44.5))
    p.addLine(to: .init(x: 15.1, y: 44.5))
    p.addCurve(to: .init(x: 8, y: 37.4), control1: .init(x: 11.2, y: 44.5), control2: .init(x: 8, y: 41.3))
    p.addLine(to: .init(x: 8, y: 28.9))
    p.addCurve(to: .init(x: 11.5, y: 25.4), control1: .init(x: 8, y: 27), control2: .init(x: 9.6, y: 25.4))
    p.closeSubpath()
    return p.applying(CGAffineTransform(scaleX: rect.width / 64, y: rect.height / 64))
  }
}

// The window's own 16×16 icons, stroked 1.5 with round ends.
struct SettingsIcon: Shape {
  func path(in rect: CGRect) -> Path {
    var p = Path()
    for (a, b, y) in [(2.5, 8.5, 4.5), (11.5, 13.5, 4.5), (2.5, 4.5, 11.5), (7.5, 13.5, 11.5)] {
      p.move(to: .init(x: a, y: y))
      p.addLine(to: .init(x: b, y: y))
    }
    p.addEllipse(in: .init(x: 8.5, y: 3, width: 3, height: 3))
    p.addEllipse(in: .init(x: 4.5, y: 10, width: 3, height: 3))
    return p.applying(CGAffineTransform(scaleX: rect.width / 16, y: rect.height / 16))
  }
}

// The quick bolt: M9 1.5 3.5 9h4.5l-1 5.5 5.5-7.5H8z, filled.
struct Bolt: Shape {
  func path(in rect: CGRect) -> Path {
    var p = Path()
    p.move(to: .init(x: 9, y: 1.5))
    p.addLine(to: .init(x: 3.5, y: 9))
    p.addLine(to: .init(x: 8, y: 9))
    p.addLine(to: .init(x: 7, y: 14.5))
    p.addLine(to: .init(x: 12.5, y: 7))
    p.addLine(to: .init(x: 8, y: 7))
    p.closeSubpath()
    return p.applying(CGAffineTransform(scaleX: rect.width / 16, y: rect.height / 16))
  }
}

// An agent's or a model's words as text: `code` spans in the mono face, and, only where asked, https URLs as links shown
// as the URL they open. Never markup: this text isn't the desk's own.
struct Prose: View {
  let text: String
  var size: CGFloat = 13
  var weight: CGFloat = 400
  var links = false
  @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 100

  var body: some View {
    Text(Prose.attributed(text, size: size * scale / 100, weight: weight, links: links))
  }

  static func attributed(_ text: String, size: CGFloat, weight: CGFloat, links: Bool) -> AttributedString {
    var out = AttributedString()
    for (i, part) in text.components(separatedBy: "`").enumerated() {
      if i % 2 == 1 {
        var code = AttributedString(part)
        code.font = Font(Typeface.mono.font(size * 0.9))
        out += code
        continue
      }
      for (bit, isLink) in links ? Prose.urls(part) : [(part, false)] {
        var run = AttributedString(bit)
        run.font = Font(Typeface.sans.font(size, weight: weight))
        if isLink, let url = URL(string: bit) {
          run.link = url
          run.foregroundColor = Theme.ink2
          run.underlineStyle = .single
        }
        out += run
      }
    }
    return out
  }

  // The text split at its https URLs, a URL ending before trailing punctuation as the window's does.
  static func urls(_ text: String) -> [(String, Bool)] {
    guard let re = try? NSRegularExpression(pattern: #"https://[^\s<>"'`]*[^\s<>"'`.,;:!?)\]]"#) else { return [(text, false)] }
    let whole = text as NSString
    var out: [(String, Bool)] = []
    var at = 0
    for m in re.matches(in: text, range: NSRange(location: 0, length: whole.length)) {
      if m.range.location > at { out.append((whole.substring(with: NSRange(location: at, length: m.range.location - at)), false)) }
      out.append((whole.substring(with: m.range), true))
      at = m.range.location + m.range.length
    }
    if at < whole.length { out.append((whole.substring(from: at), false)) }
    return out
  }
}
