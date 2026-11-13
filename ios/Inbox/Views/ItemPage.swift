import SwiftUI

// A PR or an issue, opened: what it is, why it's here, the AI review, its stack and what happened lately, then what this
// phone may do with it. Drawn at once from its row's card; the rest lands from GET /api/item (never /api/review, which
// carries the diff and starts the owner's AI review).
struct ItemPage: View {
  @Environment(Store.self) private var store
  @Environment(\.openURL) private var openURL
  let id: String
  @State private var detail: ItemDetail?
  @State private var failed: String?
  @State private var sawIt = false

  private var card: Card? { store.card(id) ?? detail?.card }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        if let card {
          header(card)
          why(card)
          if card.isPR { aiBlock(card) }
          if let stack = detail?.stack { stackBlock(stack) }
          activity(card)
          if detail == nil, failed == nil { LoadingLines() }
          if let failed { Text(failed).sans(13).foregroundStyle(Theme.red) }
          actions(card)
        } else if let failed {
          Text(failed).sans(14).foregroundStyle(Theme.red)
        } else {
          LoadingLines()
        }
      }
      .padding(.horizontal, Theme.pad)
      .padding(.top, 14)
      .padding(.bottom, 32)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(Theme.paper)
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(Theme.paper, for: .navigationBar)
    .task(id: store.loads) {
      switch await store.fetchItem(id) {
      case .success(let d):
        detail = d
        failed = nil
        if !sawIt {
          sawIt = true
          store.seen(d.card)
        }
      case .failure(let e):
        // What's on screen stays; the desk being away is its bubble's to say.
        if detail == nil, e != .unreachable, e != .notDesk { failed = Words.capitalized(e.words) }
      case nil: break
      }
    }
  }

  // MARK: Header

  @ViewBuilder
  private func header(_ c: Card) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .firstTextBaseline, spacing: 0) {
        Text(c.repo).sans(13, tracking: -0.005).foregroundStyle(Theme.pencil).lineLimit(1).truncationMode(.middle)
        Text("#\(String(c.number))").sans(13, 550, tabular: true, tracking: -0.005).foregroundStyle(Theme.ink2).fixedSize()
        if let s = c.stack, let pos = s.pos, let size = s.size {
          Text("\(pos)/\(size)").sans(13, tabular: true).foregroundStyle(Theme.pencil).fixedSize().padding(.leading, 6)
            .accessibilityLabel("\(pos) of \(size) open PRs in its stack")
        }
      }
      Text(c.title).sans(22, 650, tracking: -0.015).foregroundStyle(Theme.ink).lineSpacing(1)
        .fixedSize(horizontal: false, vertical: true)
      Dotted(parts: facts(c)).sans(13, tabular: true)
      if c.isPR, let item = detail?.item, (item.additions ?? 0) + (item.deletions ?? 0) > 0 {
        HStack(spacing: 6) {
          Text("+\(item.additions ?? 0)").foregroundStyle(Theme.green)
          Text("\u{2212}\(item.deletions ?? 0)").foregroundStyle(Theme.red)
        }
        .sans(13, 550, tabular: true)
      }
    }
  }

  // Who it's from, a PR's stage, and how long it has waited: the row's own facts.
  private func facts(_ c: Card) -> [Dotted.Part] {
    var out: [Dotted.Part] = []
    if c.mine {
      let through = c.authorBot == true ? ", through \(c.author ?? "")" : ""
      out.append(.init("by you\(through)", Theme.ink2))
    } else {
      out.append(.init("by \(c.author ?? c.by ?? "")\(c.authorBot == true ? " (bot)" : "")"))
    }
    // Amber only on yours, where it's work for you; in Merging your agent has it, so it stays pencil.
    if let stage = c.stage {
      out.append(.init(stage, stage == "changes requested" && c.mine && c.inflight != true ? Theme.amber : Theme.pencil))
    }
    out.append(.init(Words.age(c.resolvedAt ?? c.doneAt ?? c.waitingSince, now: store.now)))
    return out
  }

  // MARK: Why it's here

  @ViewBuilder
  private func why(_ c: Card) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      if let resolved = c.resolved {
        Lead(label: "Resolved:", text: "\(resolved). It comes back on its own if that stops being true.")
      } else if let why = c.why, !why.isEmpty, c.inflight != true {
        Prose(text: Words.capitalized(why), size: 14).foregroundStyle(Theme.ink)
      }
      if let h = c.handoff {
        Lead(label: (h.from ?? "").isEmpty ? "Handed to you:" : "From \(h.from!):", text: h.why ?? "", size: 14)
      }
      if c.inflight == true, c.resolved == nil { Dotted(parts: mergingParts(c)).sans(13) }
      if !c.active, c.resolved == nil {
        Text(Words.capitalized(Words.clearedText(c, now: store.now)) + ".").sans(13).foregroundStyle(Theme.pencil)
      }
      if let item = detail?.item, !(item.labels ?? []).isEmpty || (item.commentsTotal ?? 0) > 0 {
        Dotted(parts: [.init((item.labels ?? []).joined(separator: ", ")), .init(Words.plural(item.commentsTotal ?? 0, "comment"))])
          .sans(13)
      }
    }
  }

  // In Merging: what it waits on, and your agent's latest note.
  private func mergingParts(_ c: Card) -> [Dotted.Part] {
    let row = store.merging(c.id)
    var parts: [Dotted.Part] = [.init("In Merging"), .init(row?.waitsOn ?? "your agent has it")]
    if let note = row?.note?.text { parts.append(.init(note)) }
    return parts
  }

  // MARK: The AI review

  @ViewBuilder
  private func aiBlock(_ c: Card) -> some View {
    let open = (detail?.item?.state ?? "open") == "open"
    if let ai = detail?.ai {
      VStack(alignment: .leading, spacing: 8) {
        FlowLine(spacing: 8) {
          Text(Words.verdict[ai.verdict ?? ""] ?? Words.capitalized(ai.verdict ?? ""))
            .sans(15, 650, tracking: -0.01).foregroundStyle(ai.verdict == "skip" ? Theme.pencil : Theme.ink)
          if let risk = ai.risk { RiskMeter(risk: risk) }
          if ai.risk != "low", let reason = ai.riskReasons.first?.why { Text(reason).sans(13).foregroundStyle(Theme.pencil) }
          if detail?.aiStale == true { Text("on an earlier commit").sans(13).foregroundStyle(Theme.pencil) }
        }
        if let summary = ai.summary, !summary.isEmpty { Prose(text: summary, size: 13.5).foregroundStyle(Theme.ink).lineSpacing(3) }
        if let since = ai.since, !since.isEmpty { Lead(label: "Since your review:", text: since) }
        // No diff here for the notes to sit in, so the concerns are always listed.
        if let concerns = ai.concerns, !concerns.isEmpty {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(concerns, id: \.self) { concern in
              Prose(text: concern, size: 13).foregroundStyle(Theme.ink2).lineSpacing(3)
                .padding(.leading, 12)
                .overlay(alignment: .leading) { Theme.ruleStrong.frame(width: 2) }
            }
          }
        } else {
          Text("No concerns.").sans(13).foregroundStyle(Theme.pencil)
        }
      }
      .padding(.top, 2)
    } else if detail?.generating == true {
      Text("\(store.agent) is reviewing it.").sans(13).foregroundStyle(Theme.pencil)
    } else if detail != nil, !c.mine {
      // Your own PR says nothing until a review exists, as the window's.
      Text(open ? "No AI review yet." : "No AI review.").sans(13).foregroundStyle(Theme.pencil)
    }
  }

  // MARK: Its stack

  @ViewBuilder
  private func stackBlock(_ stack: Stack) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      SmallHead(text: "Stack on \(stack.base ?? "its base")")
      ForEach(stack.line) { m in
        let on = m.id == id
        Button {
          if !on { store.path.append(.item(m.id)) }
        } label: {
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(m.state == "merged" ? "●" : m.state == "closed" ? "×" : "○").font(.system(size: 9)).foregroundStyle(Theme.pencil)
              .frame(width: 12)
            Text("#\(String(m.number ?? 0))").sans(13, on ? 600 : 400, tabular: true).foregroundStyle(on ? Theme.ink : Theme.pencil)
              .fixedSize()
            Text(m.title ?? "").sans(13, on ? 600 : 400).foregroundStyle(on ? Theme.ink : Theme.ink2).lineLimit(1)
            Spacer(minLength: 6)
            // Only what's news.
            if m.state == "open" {
              if m.ci == "red" { Text("failing").sans(13).foregroundStyle(Theme.red).fixedSize() }
              if m.review == "changes_requested" { Text("changes").sans(13).foregroundStyle(Theme.amber).fixedSize() }
              if m.review == "approved" { Text("✓").font(.system(size: 12)).foregroundStyle(Theme.green) }
            }
          }
          .frame(minHeight: 32)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
      }
    }
  }

  // MARK: Recent activity

  @ViewBuilder
  private func activity(_ c: Card) -> some View {
    // Less the desk's own "first seen".
    let events = (detail?.activity ?? []).filter { $0.kind != "new" }
    if !events.isEmpty {
      VStack(alignment: .leading, spacing: 6) {
        SmallHead(text: "Recent activity")
        ForEach(events) { e in
          Dotted(parts: [.init(Words.eventText(e, me: store.me), Theme.ink2), .init(Words.age(e.at, now: store.now))])
            .sans(13, tabular: true)
        }
      }
    }
  }

  // MARK: What this phone may do

  @ViewBuilder
  private func actions(_ c: Card) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Theme.ruleStrong.frame(height: 1)
      if let held = heldBack(c) { Text(held).sans(13).foregroundStyle(Theme.pencil) }
      FlowLine(spacing: 8) {
        if let url = c.url.flatMap(URL.init(string:)) {
          Button("Open on GitHub") { openURL(url) }.buttonStyle(PlainAct())
        }
        if c.inflight != true {
          if c.active {
            Button("Done") { act(c, "done") }.buttonStyle(PlainAct())
          } else {
            Button("Back on the desk") { act(c, "restore") }.buttonStyle(PlainAct())
          }
          Menu {
            ForEach(SnoozeOption.times + [SnoozeOption.activity]) { option in
              Button(option.label) { act(c, "snooze", option) }
            }
            let waits = SnoozeOption.waits(c)
            if !waits.isEmpty {
              Divider()
              ForEach(waits) { option in Button(option.label) { act(c, "snooze", option) } }
            }
          } label: {
            Text("Snooze")
          }
          .buttonStyle(PlainAct())
          if !c.mine {
            Button(c.status == "muted" ? "Unmute" : "Mute") { act(c, c.status == "muted" ? "unmute" : "mute") }
              .buttonStyle(PlainAct())
          }
        }
      }
    }
    .padding(.top, 4)
  }

  // What takes it off its list goes back to the list, where the toast offers Undo; anything else stays on its page.
  private func act(_ c: Card, _ action: String, _ snooze: SnoozeOption? = nil) {
    let leaves = store.leaves(c.id, action)
    store.act(c.id, name: c.shortRef, action, snooze: snooze)
    if leaves, !store.path.isEmpty { store.path.removeLast() }
  }

  // The window's call to action for this item, which only the desk's own window may press: said once, plainly.
  private func heldBack(_ c: Card) -> String? {
    guard c.resolved == nil, c.active else { return nil }
    switch c.cta {
    case "ready": return "Marking it ready for review is done on the desk's computer."
    case "reply": return "Replying is done on the desk's computer."
    case "reviewers": return "Adding reviewers is done on the desk's computer."
    case "merge": return "Merging it is done on the desk's computer."
    default:
      if c.inflight == true { return "Your agent has it: bringing it back to the desk is done on the desk's computer." }
      if c.isPR, !c.mine { return "Approving and commenting are done on the desk's computer." }
      if !c.isPR { return "Commenting is done on the desk's computer." }
      return nil
    }
  }
}

// MARK: Small pieces an opened page shares

// Parts of one line with a dot between them, wrapping as words do.
struct Dotted: View {
  struct Part {
    let text: String
    var color: Color = Theme.pencil
    init(_ text: String, _ color: Color = Theme.pencil) {
      self.text = text
      self.color = color
    }
  }

  let parts: [Part]

  var body: some View {
    parts.filter { !$0.text.isEmpty }.enumerated().reduce(Text("")) { line, part in
      line + (part.offset > 0 ? Text("  ·  ").foregroundStyle(Theme.faint) : Text("")) + Text(part.element.text).foregroundStyle(part.element.color)
    }
    .lineSpacing(3)
    .fixedSize(horizontal: false, vertical: true)
  }
}

// A bold label, then its words, as one paragraph: "Since your review: …".
struct Lead: View {
  let label: String
  let text: String
  var size: CGFloat = 13
  var labelColor = Theme.ink
  var color = Theme.ink2
  @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 100

  var body: some View {
    let s = size * scale / 100
    var head = AttributedString(label + " ")
    head.font = Font(Typeface.sans.font(s, weight: 600))
    head.foregroundColor = labelColor
    var rest = Prose.attributed(text, size: s, weight: 400, links: false)
    rest.foregroundColor = color
    return Text(head + rest).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
  }
}

struct SmallHead: View {
  let text: String
  var body: some View {
    Text(text).sans(12.5, 550).foregroundStyle(Theme.pencil).padding(.bottom, 2)
  }
}

// The risk, as the window draws it: three steps, as many lit as it's risky, then the word, in its colour.
struct RiskMeter: View {
  let risk: String

  var body: some View {
    let lit = risk == "high" ? 3 : risk == "medium" ? 2 : 1
    let color = risk == "high" ? Theme.red : risk == "medium" ? Theme.amber : Theme.green
    HStack(alignment: .center, spacing: 6) {
      HStack(spacing: 2) {
        ForEach(0..<3, id: \.self) { i in
          RoundedRectangle(cornerRadius: 1).fill(color.opacity(i < lit ? 1 : 0.25)).frame(width: 4, height: 11)
        }
      }
      .accessibilityHidden(true)
      Text("\(risk) risk").sans(13, risk == "low" ? 500 : 600).foregroundStyle(color)
    }
    .fixedSize()
  }
}

// A plain button: a hairline edge on the sheet, as the window's.
struct PlainAct: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .sans(13, 500)
      .foregroundStyle(Theme.ink)
      .padding(.horizontal, 12)
      .frame(minHeight: 36)
      .background(configuration.isPressed ? Theme.wash : Theme.sheet, in: RoundedRectangle(cornerRadius: 9))
      .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Theme.ruleStrong, lineWidth: 1))
      .contentShape(Rectangle().inset(by: -4))
  }
}

// Things on a line that wrap onto the next when they run out of room.
struct FlowLine: Layout {
  var spacing: CGFloat = 8

  private func rows(_ subviews: Subviews, width: CGFloat) -> [[(Int, CGSize)]] {
    var rows: [[(Int, CGSize)]] = [[]]
    var x: CGFloat = 0
    for (i, v) in subviews.enumerated() {
      let size = v.sizeThatFits(ProposedViewSize(width: width, height: nil))
      if x > 0, x + size.width > width {
        rows.append([])
        x = 0
      }
      rows[rows.count - 1].append((i, size))
      x += size.width + spacing
    }
    return rows
  }

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    var height: CGFloat = 0
    var widest: CGFloat = 0
    for row in rows(subviews, width: width) {
      height += (row.map(\.1.height).max() ?? 0) + (height > 0 ? spacing : 0)
      let across: CGFloat = row.map(\.1.width).reduce(0, +) + CGFloat(max(0, row.count - 1)) * spacing
      widest = max(widest, across)
    }
    return CGSize(width: min(width, widest), height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var y = bounds.minY
    for row in rows(subviews, width: bounds.width) {
      let height = row.map(\.1.height).max() ?? 0
      var x = bounds.minX
      for (i, size) in row {
        subviews[i].place(
          at: CGPoint(x: x, y: y + (height - size.height) / 2), proposal: ProposedViewSize(width: min(size.width, bounds.width), height: size.height))
        x += size.width + spacing
      }
      y += height + spacing
    }
  }
}

// Text on its way: a few calm bars.
struct LoadingLines: View {
  @State private var shown = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach([0.9, 0.75, 0.5], id: \.self) { w in
        RoundedRectangle(cornerRadius: 4).fill(Theme.wash).frame(height: 10).frame(maxWidth: .infinity, alignment: .leading)
          .scaleEffect(x: w, anchor: .leading)
      }
    }
    .opacity(shown ? 1 : 0)
    .task {
      try? await Task.sleep(for: .milliseconds(150))
      withAnimation(.easeOut(duration: 0.2)) { shown = true }
    }
    .accessibilityHidden(true)
  }
}
