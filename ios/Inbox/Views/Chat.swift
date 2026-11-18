import SwiftUI
import UIKit

// Ask your agent: your chat with the coordinator, as the window's (web/src/components/Chat.tsx). One conversation,
// every ask oldest first, each with what it was about and its answer; under the last one it hasn't answered, what it's
// said so far and what it's doing. Opening it reads GET /api/asks and nothing else; only Send and Wake it spend a turn
// of your agent. Its answers are an agent's words: drawn as text (ProseBlocks), never markup.
struct ChatPage: View {
  @Environment(Store.self) private var store
  @Environment(\.openURL) private var openURL
  @State private var about: ChatAbout
  @State private var text = ""
  @State private var woke: String?  // what Wake it came to
  @State private var tall = false  // the box over the log, to write at length
  @State private var picked: [String: String] = [:]  // a menu's pick, until the desk says it back
  @State private var unsaved: String?  // why the desk didn't take a pick, in its words
  @State private var naming = false  // Another model…'s field
  @State private var named = ""
  @FocusState private var typing: Bool
  @ScaledMetric(relativeTo: .body) private var mark: CGFloat = 17

  init(about: ChatAbout) { _about = State(initialValue: about) }

  private var key: String { about.item ?? "" }
  private var failed: String? { store.askFailed[key] }  // why the last send wasn't taken, in the desk's words
  private var off: Bool { store.asks?.on == false }
  private var sending: Bool { store.busy(Store.chat) }
  private var asks: [Ask] { store.asks?.asks ?? [] }
  // Nothing asked yet, or the box expanded: it takes the page, you write at its top and its controls keep the foot.
  private var fill: Bool { (store.asks != nil && asks.isEmpty) || tall }
  private var kind: AgentKind { AgentKind.of(store.asks?.options?.agent) }

  var body: some View {
    Group {
      if fill {
        ScrollView {
          VStack(alignment: .leading, spacing: 6) {
            hints
            field
          }
          .padding(.horizontal, Theme.pad)
          .padding(.top, 10)
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .contentShape(Rectangle())
        .onTapGesture { if !off { typing = true } }
      } else {
        log
      }
    }
    .safeAreaInset(edge: .top, spacing: 0) { head }
    .openedPage()
    .safeAreaInset(edge: .bottom, spacing: 0) { box }
    .onAppear { if text.isEmpty { text = store.askDrafts[key] ?? "" } }
    .onChange(of: text) { _, typed in
      if typed.count > Words.maxAsk { text = String(typed.prefix(Words.maxAsk)) }
      store.askDrafts[key] = typed.isEmpty ? nil : typed
    }
    // Words the desk didn't take come back through the draft (Store.ask), whether or not this page was here meanwhile.
    .onChange(of: store.askDrafts[key]) { _, kept in
      if (kept ?? "") != text { text = kept ?? "" }
    }
    .onChange(of: store.asks?.coordinator?.status) { woke = nil }
    // Read on open, then on each of the desk's updates once they settle. No timer.
    .task(id: store.loads) {
      if store.asks != nil {
        try? await Task.sleep(for: .milliseconds(300))
        if Task.isCancelled { return }
      }
      await store.readAsks()
    }
    .alert("Another model", isPresented: $naming) {
      TextField("Another model", text: $named).textInputAutocapitalization(.never).autocorrectionDisabled()
      Button("Cancel", role: .cancel) {}
      Button("Save") {
        let model = named.trimmingCharacters(in: .whitespacesAndNewlines)
        if !model.isEmpty { save("agent.coordinator_model", "model", .text(model), shown: model) }
      }
    } message: {
      Text("Its name as \(kind.name)'s own command takes it.")
    }
  }

  // MARK: Its head

  // Your agent's own name and mark, once the desk has said which it is.
  private var head: some View {
    HStack(alignment: .center, spacing: 10) {
      if let agent = store.asks?.options?.agent {
        HStack(spacing: 7) {
          AgentMark(agent: agent).fill(Theme.ink, style: FillStyle(eoFill: true)).frame(width: mark, height: mark)
            .accessibilityHidden(true)
          Text(AgentKind.of(agent).name).sans(16, 650, tracking: -0.01).foregroundStyle(Theme.ink)
        }
        .fixedSize()
      } else {
        Text("Your agent").sans(16, 650, tracking: -0.01).foregroundStyle(Theme.ink).fixedSize()
      }
      if let item = about.item {
        Text(Asking.shortId(item)).sans(13, tabular: true).foregroundStyle(Theme.pencil).lineLimit(1).truncationMode(.middle)
        drop("Ask about nothing in particular")
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, Theme.pad)
    .frame(minHeight: 44)
    .background(Theme.paper)
    .overlay(alignment: .bottom) { Theme.rule.frame(height: 1) }
  }

  // The window's x: one step wider. What you'd typed goes with you.
  private func drop(_ says: String) -> some View {
    Button {
      let wider = about.wider
      let to = wider.item ?? ""
      if to != key {
        store.askDrafts[key] = nil
        if text.isEmpty { text = store.askDrafts[to] ?? "" } else { store.askDrafts[to] = text }
      }
      about = wider
    } label: {
      Text("\u{00D7}").sans(17).foregroundStyle(Theme.pencil)
        .frame(width: 24, height: 24)
        .contentShape(Rectangle().inset(by: -10))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(says)
  }

  // MARK: The log

  private var log: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          ForEach(Array(asks.enumerated()), id: \.element.id) { i, a in turn(a, last: i == asks.count - 1, proxy).id(a.id) }
        }
        .padding(.horizontal, Theme.pad)
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .scrollDismissesKeyboard(.interactively)
      // The newest turn's top: your words and the answer's lead, not the end of a long answer.
      .onChange(of: "\(asks.count) \(asks.filter { $0.answer != nil }.count) \(failed ?? "")", initial: true) {
        guard let last = asks.last else { return }
        proxy.scrollTo(last.id, anchor: .top)
        // Again once it's laid out: the first go lands where the turn was guessed to be.
        Task {
          for wait in [80, 300] {
            try? await Task.sleep(for: .milliseconds(wait))
            proxy.scrollTo(last.id, anchor: .top)
          }
        }
      }
    }
  }

  private func turn(_ a: Ask, last: Bool, _ proxy: ScrollViewProxy) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(a.text ?? "").sans(14).foregroundStyle(Theme.ink).lineSpacing(3)
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Theme.wash, in: RoundedRectangle(cornerRadius: 10))
        .padding(.leading, 36)
        .frame(maxWidth: .infinity, alignment: .trailing)
      meta(a).frame(maxWidth: .infinity, alignment: .trailing)
      if let answer = a.answer {
        answered(answer, to: a.id, proxy)
      } else if last {
        // What it's said so far, a message at a time, until its answer takes its place: a shade quieter than an answer.
        if let saying = store.asks?.coordinator?.saying, !saying.isEmpty {
          ProseBlocks(blocks: Blocks.parse(saying), color: Theme.ink2)
        }
        waiting(a)
      }
    }
  }

  // An answer and when; its tools (the window's at its foot) are its long press.
  private func answered(_ answer: Ask.Answer, to ask: String, _ proxy: ScrollViewProxy) -> some View {
    let words = answer.text ?? ""
    let copy = {
      UIPasteboard.general.string = words
      store.flash("Copied the answer")
    }
    return VStack(alignment: .leading, spacing: 6) {
      ProseBlocks(text: words)
      Text(Words.sinceText(answer.at, now: store.now)).sans(12.5, tabular: true).foregroundStyle(Theme.pencil)
    }
    .contentShape(Rectangle())
    .contextMenu {
      Button(action: copy) { Label("Copy this answer", systemImage: "doc.on.doc") }
      Button {
        withAnimation { proxy.scrollTo(ask, anchor: .top) }
      } label: {
        Label("Go to what you asked", systemImage: "arrow.up")
      }
    }
    .accessibilityAction(named: "Copy this answer", copy)
  }

  // When, then what it was about: its item (a press opens it), the lines, the thread (on GitHub).
  private func meta(_ a: Ask) -> some View {
    let parts = Asking.meta(a, now: store.now, agent: store.agent)
    return FlowLine(spacing: 0) {
      ForEach(Array(parts.enumerated()), id: \.offset) { i, part in
        HStack(alignment: .firstTextBaseline, spacing: 0) {
          if i > 0 { Text("·").foregroundStyle(Theme.faint).padding(.horizontal, 6) }
          if let item = a.itemId, part == Asking.shortId(item) {
            link(part) { if store.card(item) != nil { store.path.append(.item(item)) } else if let url = Words.issueURL(item) { openURL(url) } }
          } else if part == "on a thread", let url = github(a.threadUrl) {
            link(part) { openURL(url) }
          } else {
            Text(part).lineLimit(1).truncationMode(.middle)
          }
        }
      }
    }
    .sans(12.5, tabular: true)
    .foregroundStyle(Theme.pencil)
  }

  private func link(_ words: String, _ press: @escaping () -> Void) -> some View {
    Button(action: press) {
      Text(words).underline(color: Theme.ruleStrong).contentShape(Rectangle().inset(by: -12))
    }
    .buttonStyle(.plain)
  }

  // Only GitHub's own address is opened from an ask (the desk takes no other), and only claude.ai's page over https.
  private func github(_ raw: String?) -> URL? { (raw ?? "").hasPrefix("https://github.com/") ? URL(string: raw ?? "") : nil }
  private var watch: URL? { (store.asks?.coordinator?.url).flatMap { $0.hasPrefix("https://") ? URL(string: $0) : nil } }

  // What it's doing about the ask it hasn't answered: on it, queued, stuck on a permission, or stopped, with a way to
  // see it or wake it.
  private func waiting(_ a: Ask) -> some View {
    let wait = Wait(ask: a.id, live: store.asks?.coordinator)
    let color: Color = { if case .cantRun = wait { Theme.red } else if case .step = wait { Theme.ink2 } else { Theme.pencil } }()
    return FlowLine(spacing: 8) {
      HStack(alignment: .center, spacing: 8) {
        if wait.busy { ProgressView().controlSize(.mini).tint(Theme.pencil).accessibilityHidden(true) }
        Prose(text: wait == .stopped ? woke ?? wait.words : wait.words, size: 13).foregroundStyle(color).lineSpacing(3)
          .fixedSize(horizontal: false, vertical: true)
          .contentTransition(.opacity)
          .animation(.easeOut(duration: 0.2), value: wait.words)
      }
      if wait == .stopped {
        Button("Wake it") {
          Task { woke = await store.wake(ask: a.id, toast: false) ? "Asked it again" : Words.sentence(store.whyNot ?? "It wasn't sent") }
        }
        .buttonStyle(PlainAct())
        .disabled(store.busy(Store.agentWake))
      }
      if let says = wait.link, let watch {
        Button {
          openURL(watch)
        } label: {
          Text(says).sans(13).underline(color: Theme.ruleStrong).foregroundStyle(Theme.pencil).frame(minHeight: 28)
            .contentShape(Rectangle().inset(by: -8))
        }
        .buttonStyle(.plain)
      }
    }
    .accessibilityElement(children: .contain)
  }

  // MARK: The box

  // Your agent's open questions about the item, and the spot the next ask carries.
  private var hints: some View {
    let questions = (store.queue?.inquiries ?? []).filter { Words.isCoordinator($0.from) && $0.itemId == about.item && $0.answer == nil && !store.leaving.contains($0.id) }
    return VStack(alignment: .leading, spacing: 6) {
      ForEach(questions) { q in
        HStack(alignment: .firstTextBaseline, spacing: 0) {
          Text("Your agent asks: \(q.question ?? "")").lineLimit(1)
          Text("·").foregroundStyle(Theme.faint).padding(.horizontal, 6)
          Button {
            store.path.append(.inquiry(q.id))
          } label: {
            Text("Answer").underline(color: Theme.ruleStrong).foregroundStyle(Theme.ink2).fixedSize().contentShape(Rectangle().inset(by: -10))
          }
          .buttonStyle(.plain)
        }
      }
      if let spot = about.spot {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
          Text("On \(spot)").lineLimit(1).truncationMode(.middle)
          drop("Ask about the whole PR instead")
        }
      }
    }
    .sans(12.5)
    .foregroundStyle(Theme.pencil)
  }

  // No frame of its own: you write on the page. Once there's a conversation, its corner expands it over the log.
  private var field: some View {
    TextField(off ? "Your agent is off" : Asking.placeholder(about.item), text: $text, axis: .vertical)
      .sans(15).foregroundStyle(Theme.ink).lineLimit(fill ? 3...200 : 1...6).focused($typing).disabled(off)
      .padding(.vertical, 8)
      .padding(.trailing, asks.isEmpty ? 0 : 36)
      .overlay(alignment: .topTrailing) {
        if !asks.isEmpty {
          Button {
            tall.toggle()
            if !off { typing = true }
          } label: {
            Image(systemName: tall ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
              .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.pencil)
              .frame(width: 44, height: 40, alignment: .topTrailing).padding(.top, 9)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel(tall ? "Shrink the box" : "Expand the box")
          .accessibilityHint(tall ? "Back to the conversation" : "To write at length")
        }
      }
      .accessibilityLabel("Your words to your agent")
  }

  // The hints and the field (unless they fill the page), what wasn't taken, then Back, how it runs and Send.
  private var box: some View {
    VStack(spacing: 0) {
      NoticeStack()
      VStack(alignment: .leading, spacing: 4) {
        if !fill {
          hints
          field
        }
        if let failed { said(failed) }
        if let unsaved { said(unsaved) }
        controls
      }
      .padding(.horizontal, Theme.pad)
      .padding(.top, fill ? 0 : 6)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Theme.paper)
      .overlay(alignment: .top) { if !fill { Theme.rule.frame(height: 1) } }
    }
  }

  private func said(_ refused: String) -> some View {
    Text(refused).sans(12.5).foregroundStyle(Theme.red).fixedSize(horizontal: false, vertical: true)
  }

  // On one line where they fit; else how it runs takes a line of its own above Back and Send.
  @ViewBuilder private var controls: some View {
    if off {
      HStack(alignment: .center, spacing: 8) {
        back
        Text(Asking.off).sans(12.5).foregroundStyle(Theme.pencil).fixedSize(horizontal: false, vertical: true)
      }
    } else {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 2) {
          back
          options
          Spacer(minLength: 4)
          sendButton
        }
        VStack(alignment: .leading, spacing: 0) {
          FlowLine(spacing: 2) { options }
          HStack {
            back
            Spacer(minLength: 0)
            sendButton
          }
        }
      }
    }
  }

  private var back: some View {
    Button {
      if !store.path.isEmpty { store.path.removeLast() }
    } label: {
      Image(systemName: "chevron.left").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.ink2)
        .frame(width: 30, height: 44, alignment: .leading)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Back")
  }

  // The accent's square with a paper plane, pale until there's something to send.
  private var sendButton: some View {
    let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    let on = !empty && !sending
    return Button(action: send) {
      ZStack {
        if sending {
          ProgressView().controlSize(.small).tint(Theme.faint)
        } else {
          Image(systemName: "paperplane").font(.system(size: 15, weight: .medium))
        }
      }
      .foregroundStyle(on ? Theme.onAccent : Theme.faint)
      .frame(width: 36, height: 36)
      .background(on ? Theme.accent : Theme.wash, in: RoundedRectangle(cornerRadius: 9))
      .frame(width: 44, height: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!on)
    .accessibilityLabel(sending ? "Sending" : "Send")
  }

  // Emptied at once, as the window's box; a refusal puts your words back, with the desk's own in red.
  private func send() {
    let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !words.isEmpty, !sending, !off else { return }
    let about = about
    text = ""
    tall = false
    Task { await store.ask(words, about: about) }
  }

  // MARK: How it runs

  // The window's three menus by Send, the same settings as Settings → Agent, each saved as it's picked.
  @ViewBuilder private var options: some View {
    if let o = store.asks?.options {
      let bypass = picked["bypass"].map { $0 == "1" } ?? (o.bypass ?? false)
      let model = picked["model"] ?? o.model ?? ""
      let effort = picked["effort"] ?? o.effort ?? ""
      let models = kind.models(model, read: store.asks?.models?.models ?? [])
      let efforts = kind.efforts(effort, read: store.asks?.models?.efforts ?? [])
      pick(
        "How freely \(kind.name) runs", tip: "How freely \(kind.name) runs; it can't post as you either way", said: kind.run[bypass ? 1 : 0],
        choices: [.init(value: "0", label: kind.run[0]), .init(value: "1", label: kind.run[1])], value: bypass ? "1" : "0"
      ) { save("agent.coordinator_bypass", "bypass", .flag($0 == "1"), shown: $0) }
      pick("\(kind.name)'s model", tip: "\(kind.name)'s model", said: AgentKind.said(models, value: model, none: "Model"), choices: models, value: model, other: true) {
        save("agent.coordinator_model", "model", .text($0), shown: $0)
      }
      if efforts.count > 1 {
        pick("\(kind.name)'s effort", tip: "How hard \(kind.name) thinks", said: AgentKind.said(efforts, value: effort, none: "Effort"), choices: efforts, value: effort) {
          save("agent.coordinator_effort", "effort", .text($0), shown: $0)
        }
      }
    }
  }

  // Its words open the menu, the one in force ticked; `other` adds Another model…, for a name it doesn't list.
  private func pick(
    _ label: String, tip: String, said: String, choices: [AgentKind.Choice], value: String, other: Bool = false, onPick: @escaping (String) -> Void
  ) -> some View {
    Menu {
      Picker(tip, selection: Binding(get: { value }, set: { if $0 != value { onPick($0) } })) {
        ForEach(choices, id: \.value) { Text($0.label).tag($0.value) }
      }
      .pickerStyle(.inline)
      if other {
        Button("Another model\u{2026}") {
          named = ""
          naming = true
        }
      }
    } label: {
      HStack(spacing: 3) {
        Text(said).lineLimit(1).truncationMode(.middle)
        Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
      }
      .sans(13)
      .foregroundStyle(Theme.pencil)
      .padding(.horizontal, 6)
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .menuOrder(.fixed)
    .accessibilityLabel("\(label): \(said)")
  }

  // Shown at once; the desk's own words in red under the box when it doesn't take, and the chat read again either way.
  private func save(_ key: String, _ field: String, _ value: SettingValue, shown: String) {
    picked[field] = shown
    unsaved = nil
    Task {
      let took = await store.setAgentOption(key, value)
      picked[field] = nil
      if !took { unsaved = store.whyNot ?? "Not saved" }
    }
  }
}

// An agent's words as the blocks they were written in (Blocks.parse): paragraphs, lists, bold, `code`, and a code block
// on the sheet with a quiet Copy that keeps its fence. Text only: a URL is shown, never followed.
struct ProseBlocks: View {
  let blocks: [Block]
  var size: CGFloat = 14
  var color = Theme.ink
  @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 100
  @State private var copied: Set<Int> = []

  init(text: String, size: CGFloat = 14) {
    blocks = Blocks.parse(text)
    self.size = size
  }

  init(blocks: [Block], size: CGFloat = 14, color: Color = Theme.ink) {
    self.blocks = blocks
    self.size = size
    self.color = color
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { i, block in
        switch block {
        case .p(let spans): line(spans)
        case .ul(let items): list(items.map { ("\u{2022}", $0) })
        case .ol(let start, let items): list(items.enumerated().map { ("\(start + $0.offset).", $0.element) })
        case .pre(let code, let info): pre(code, info, i)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func line(_ spans: [Span]) -> some View {
    let s = size * scale / 100
    var out = AttributedString()
    for span in spans {
      var run = AttributedString(span.text)
      run.font = Font(span.code ? Typeface.mono.font(s * 0.9, weight: span.bold ? 600 : 400) : Typeface.sans.font(s, weight: span.bold ? 600 : 400))
      if span.link != nil { run.underlineStyle = .single }  // a reviewer's link: its words, to copy (SaidText)
      out += run
    }
    return Text(out).foregroundStyle(color).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
  }

  private func list(_ items: [(String, [Span])]) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(Array(items.enumerated()), id: \.offset) { _, item in
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(item.0).sans(size, tabular: true).foregroundStyle(Theme.pencil).frame(minWidth: 14, alignment: .trailing)
          line(item.1)
        }
      }
    }
  }

  // Wrapped, not scrolled: no part of a command hides past the block's edge (and a sideways scroll would fight the swipe back).
  private func pre(_ code: String, _ info: String, _ i: Int) -> some View {
    VStack(alignment: .trailing, spacing: 0) {
      Text(code).mono(12.5).foregroundStyle(Theme.ink).lineSpacing(3)
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.sheet, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.rule, lineWidth: 1))
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
      Button {
        UIPasteboard.general.string = Blocks.fencedCopy(code, info: info)
        copied.insert(i)
      } label: {
        Text(copied.contains(i) ? "Copied" : "Copy").sans(12.5).foregroundStyle(Theme.ink2)
          .padding(.horizontal, 6).frame(minHeight: 30)
          .contentShape(Rectangle().inset(by: -7))
      }
      .buttonStyle(.plain)
      .accessibilityHint("Copies it with its fence, to paste on GitHub")
    }
  }
}
