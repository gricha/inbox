import SwiftUI

// The window's two-line row (CardRow's `compact`, web/src/styles.css `.c-row`): the title, at most two lines; then one
// line of facts with a dot between them, the row's call to action as accent text, and its age at the right.

// A row's facts on one line. When they don't fit, a long repo name gives way first, then the why, then the last fact,
// each down to a few letters; the rest never shrink.
struct MetaLine: Layout {
  struct Shrink: LayoutValueKey {
    static let defaultValue: (order: Int, floor: CGFloat)? = nil
  }

  private func widths(_ subviews: Subviews, in available: CGFloat?) -> [CGFloat] {
    var widths = subviews.map { $0.sizeThatFits(.unspecified).width }
    guard let available else { return widths }
    var over = widths.reduce(0, +) - available
    let order = subviews.indices.filter { subviews[$0][Shrink.self] != nil }.sorted { subviews[$0][Shrink.self]!.order < subviews[$1][Shrink.self]!.order }
    for i in order where over > 0 {
      let give = min(over, max(0, widths[i] - min(widths[i], subviews[i][Shrink.self]!.floor)))
      widths[i] -= give
      over -= give
    }
    // Still too wide: the last one that can shrink takes the rest.
    if over > 0, let last = order.last { widths[last] = max(0, widths[last] - over) }
    // A cut text draws narrower than its room: what that leaves goes back, to the last fact first.
    let ideal = subviews.map { $0.sizeThatFits(.unspecified).width }
    let drawn = subviews.indices.map { min(widths[$0], subviews[$0].sizeThatFits(ProposedViewSize(width: widths[$0], height: nil)).width) }
    var slack = available - drawn.reduce(0, +)
    for i in order.reversed() where slack > 0 && widths[i] < ideal[i] {
      widths[i] = min(ideal[i], drawn[i] + slack)
      slack -= widths[i] - drawn[i]
    }
    return widths
  }

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let w = widths(subviews, in: proposal.width)
    let height = subviews.map { $0.sizeThatFits(.unspecified).height }.max() ?? 0
    return CGSize(width: min(w.reduce(0, +), proposal.width ?? .infinity), height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let w = widths(subviews, in: bounds.width)
    let baseline = subviews.map { $0.dimensions(in: .unspecified)[.firstTextBaseline] }.max() ?? 0
    var x = bounds.minX
    for (i, v) in subviews.enumerated() {
      let d = v.dimensions(in: ProposedViewSize(width: w[i], height: nil))
      v.place(at: CGPoint(x: x, y: bounds.minY + baseline - d[.firstTextBaseline]), proposal: ProposedViewSize(width: w[i], height: nil))
      // A cut text is drawn narrower than the room it was given: the next fact follows what's drawn.
      x += min(w[i], d.width)
    }
  }
}

extension View {
  // The order this fact gives way in (lowest first), and the width it keeps.
  func shrinks(_ order: Int, floor: CGFloat) -> some View { layoutValue(key: MetaLine.Shrink.self, value: (order, floor)) }
}

// One fact of a row's second line.
struct Fact: Identifiable {
  enum Tone { case pencil, ink2, amber }
  let text: String
  var tone: Tone = .pencil
  var shrink: (order: Int, floor: CGFloat)?
  var id: String { text }
}

// The two lines every row shares. `kind` is the small label (PR, Issue, Question, Session, Note); none on Merging.
struct RowLines: View {
  var kind: String?
  var quick: String?
  let title: String
  var dim = false
  var repo: String?  // the ref's name, which gives way first
  var number: String?  // "#4127": never cut
  var stack: String?  // "3/20"
  var stackSays: String?
  var facts: [Fact] = []
  var cta: String?
  var age: String
  var under: String?  // a line of its own under the facts: why it's blocked, your agent's note

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .sans(15, dim ? 400 : 500, tracking: -0.008)
        .foregroundStyle(dim ? Theme.ink2 : Theme.ink)
        .lineLimit(2)
        .lineSpacing(1.5)
        .frame(maxWidth: .infinity, alignment: .leading)
      HStack(alignment: .firstTextBaseline, spacing: 0) {
        MetaLine {
          if let kind {
            Text(kind).sans(11.5, 600, tracking: 0.02).padding(.trailing, quick == nil ? 8 : 4)
          }
          if let quick {
            Bolt().fill(Theme.accentInk).frame(width: 14, height: 14)
              .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
              .padding(.trailing, 8)
              .accessibilityLabel(quick)
          }
          if let repo {
            Text(repo).lineLimit(1).truncationMode(.tail).shrinks(0, floor: 44)
          }
          if let number { Text(number).fixedSize() }
          if let stack {
            Text(stack).fixedSize().padding(.leading, 6).accessibilityLabel(stackSays ?? stack)
          }
          ForEach(Array(facts.enumerated()), id: \.offset) { i, fact in
            if i > 0 || repo != nil || number != nil { Text("·").foregroundStyle(Theme.faint).padding(.horizontal, 6).fixedSize() }
            factText(fact, last: i == facts.count - 1)
          }
        }
        .sans(13, tabular: true)
        .foregroundStyle(Theme.pencil)
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipped()
        if let cta {
          Text(cta).sans(13, 600).foregroundStyle(Theme.accentInk).fixedSize().padding(.leading, 10)
        }
        Text(age).sans(13, tabular: true).foregroundStyle(Theme.pencil).fixedSize().padding(.leading, cta == nil ? 10 : 8)
      }
      // One line with parts that never shrink: past the largest standard size they'd push the facts off the row. The title keeps growing.
      .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
      if let under, !under.isEmpty {
        Text(under).sans(13).foregroundStyle(Theme.pencil).lineLimit(2).lineSpacing(1.5)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .padding(.init(top: 10, leading: Theme.pad, bottom: 11, trailing: Theme.pad))
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(Rectangle())
  }

  @ViewBuilder
  private func factText(_ fact: Fact, last: Bool) -> some View {
    let text = Text(fact.text).lineLimit(1).truncationMode(.tail)
      .foregroundStyle(fact.tone == .amber ? Theme.amber : fact.tone == .ink2 ? Theme.ink2 : Theme.pencil)
    if let s = fact.shrink {
      text.shrinks(s.order, floor: s.floor)
    } else if last {
      text.shrinks(2, floor: 56)
    } else {
      text.fixedSize()
    }
  }
}

// What a list page says about a card after its ref.
enum RowVariant {
  case active  // the Inbox: its reason, who, its stage, its call to action
  case blocked  // why it can't move, on a line of its own
  case note(String)  // the Archive: why it's there
}

struct CardRow: View {
  let card: Card
  let variant: RowVariant
  let now: Date

  var body: some View {
    RowLines(
      kind: card.isPR ? "PR" : "Issue",
      quick: card.quick,
      title: card.title,
      dim: dim,
      repo: card.repo.split(separator: "/").last.map(String.init) ?? card.repo,
      number: "#\(card.number)",
      stack: card.stack.flatMap { s in s.pos.flatMap { p in s.size.map { "\(p)/\($0)" } } },
      stackSays: card.stack.map { "\($0.pos ?? 0) of \($0.size ?? 0) open PRs in its stack" },
      facts: facts,
      cta: cta,
      age: Words.age(since, now: now),
      under: under
    )
    .accessibilityElement(children: .combine)
  }

  private var dim: Bool {
    if case .note = variant { true } else { false }
  }

  // A resolved item isn't waiting any more: its time is when it resolved. On Blocked, since it was blocked.
  private var since: String? {
    if case .blocked = variant { return card.waitingSince }
    return card.resolvedAt ?? card.doneAt ?? card.waitingSince
  }

  private var cta: String? {
    guard case .active = variant, let cta = card.cta else { return nil }
    return Words.cta[cta]
  }

  private var under: String? {
    if case .blocked = variant { card.why } else { nil }
  }

  private var facts: [Fact] {
    var out: [Fact] = []
    switch variant {
    case .active:
      if let reason = card.reason, !reason.isEmpty { out.append(Fact(text: Words.capitalized(reason), shrink: (1, 70))) }
    case .note(let note):
      if !note.isEmpty { out.append(Fact(text: note, shrink: (1, 70))) }
    case .blocked: break
    }
    // A call to action says the row is yours: there "by you" goes, so its stage keeps its room.
    if let by = card.by, !(cta != nil && card.mine) { out.append(Fact(text: "by \(by)", tone: card.mine ? .ink2 : .pencil)) }
    // Amber only on yours, where it's work for you.
    if case .active = variant, let stage = card.stage {
      out.append(Fact(text: stage, tone: stage == "changes requested" && card.mine ? .amber : .pencil))
    }
    return out
  }
}

struct InquiryRow: View {
  let q: Inquiry
  let now: Date

  var body: some View {
    RowLines(
      kind: "Question", title: q.question ?? "", facts: [Fact(text: "by \(Words.fromName(q.from, start: false))")],
      cta: "Answer", age: Words.age(q.at, now: now)
    )
    .accessibilityElement(children: .combine)
  }
}

struct SessionRow: View {
  let s: SessionCard
  let now: Date

  var body: some View {
    let folder = (s.cwd ?? "").split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? (s.cwd ?? "")
    let first = s.actions?.first
    // At a phone's width the reason stays and the kind goes, as the window's narrow table has it.
    RowLines(
      kind: "Session", title: s.name ?? "", repo: folder, facts: [Fact(text: s.reason ?? "")],
      cta: first == "attach" ? nil : first.flatMap { Words.sessionAction[$0] }, age: Words.age(s.since, now: now)
    )
    .accessibilityElement(children: .combine)
  }
}

// A note to yourself: read here, written and finished on the desk.
struct NoteRow: View {
  let n: Note
  let now: Date

  var body: some View {
    let later = Words.date(n.remindAt).map { $0 > now } ?? false
    RowLines(
      kind: "Note", title: n.text ?? "",
      facts: [Fact(text: n.remindAt != nil ? "at \(Words.when(n.remindAt, now: now))" : "by you")],
      age: Words.age(n.remindAt != nil && !later ? n.remindAt : n.at, now: now)
    )
    .accessibilityElement(children: .combine)
  }
}

// Merging: no kind label; its ref, what it waits on, and your agent's latest note under it.
struct MergingRow: View {
  let row: InflightView.Row
  let now: Date

  var body: some View {
    let c = row.card
    let live = row.state == "open"
    RowLines(
      title: c.title, dim: !live,
      repo: c.repo.split(separator: "/").last.map(String.init) ?? c.repo, number: "#\(c.number)",
      stack: c.stack.flatMap { s in s.pos.flatMap { p in s.size.map { "\(p)/\($0)" } } },
      stackSays: c.stack.map { "\($0.pos ?? 0) of \($0.size ?? 0) open PRs in its stack" },
      facts: [Fact(text: live ? (row.waitsOn ?? "merging") : (row.state ?? ""))],
      age: Words.age(c.resolvedAt ?? c.waitingSince, now: now),
      under: live ? row.note?.text : nil
    )
    .accessibilityElement(children: .combine)
  }
}

// A section's heading: its name and its count on one baseline; a tap folds it.
struct GroupHead: View {
  let label: String
  let count: Int
  var open = true
  var toggle: (() -> Void)?

  var body: some View {
    let head = HStack(alignment: .firstTextBaseline, spacing: 10) {
      Text(label).sans(15, 650, tracking: -0.01).foregroundStyle(open ? Theme.ink : Theme.pencil)
      Text("\(count)").sans(13, 450, tabular: true).foregroundStyle(Theme.pencil)
      Spacer(minLength: 0)
    }
    // On the sheet, as the heading of the window's two-line list. One that folds takes a finger, so it's 44pt tall with
    // its words at the foot: a List gives a heading no touch outside its own frame.
    .padding(.init(top: 4, leading: Theme.pad, bottom: 8, trailing: Theme.pad))
    .frame(maxWidth: .infinity, minHeight: 44, alignment: .bottomLeading)
    .background(Theme.sheet)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
    if let toggle {
      Button(action: toggle) { head }.buttonStyle(.plain).accessibilityHint(open ? "Close" : "Open")
    } else {
      head
    }
  }
}

// One quiet line where a list would be: an empty page, a desk's first minutes.
struct QuietLine: View {
  let text: String
  var size: CGFloat = 16

  var body: some View {
    Text(text).sans(size).foregroundStyle(Theme.pencil).lineSpacing(3)
      .padding(.init(top: 24, leading: Theme.pad, bottom: 10, trailing: Theme.pad))
      .frame(maxWidth: .infinity, alignment: .leading)
  }
}

// Rows on their way: calm bars where a heading and its rows will land.
struct LoadingRows: View {
  @State private var shown = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      bar(70).padding(.init(top: 26, leading: Theme.pad, bottom: 12, trailing: 0))
      ForEach(0..<6, id: \.self) { i in
        VStack(alignment: .leading, spacing: 10) {
          bar([210, 260, 180][i % 3], height: 12)
          bar(120)
        }
        .padding(.init(top: 14, leading: Theme.pad, bottom: 15, trailing: Theme.pad))
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { Theme.rule.frame(height: 1).padding(.leading, Theme.pad) }
      }
    }
    .opacity(shown ? 1 : 0)
    // Only once the wait is noticeable.
    .task {
      try? await Task.sleep(for: .milliseconds(150))
      withAnimation(.easeOut(duration: 0.2)) { shown = true }
    }
    .accessibilityHidden(true)
  }

  private func bar(_ width: CGFloat, height: CGFloat = 10) -> some View {
    RoundedRectangle(cornerRadius: 4).fill(Theme.wash).frame(width: width, height: height)
  }
}
