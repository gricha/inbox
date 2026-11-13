import SwiftUI

// The desk: one stack whose root is a list page. The window's sidebar (Inbox, Blocked, a hairline, Merging, Archive)
// is the title's menu; Settings is the icon beside it. An item, a question or a session pushes its own page.
struct DeskView: View {
  @Environment(Store.self) private var store

  var body: some View {
    @Bindable var store = store
    NavigationStack(path: $store.path) {
      ListPage()
        .navigationDestination(for: Route.self) { route in
          switch route {
          case .item(let id): ItemPage(id: id)
          case .inquiry(let id): InquiryPage(id: id)
          case .session(let id): SessionPage(id: id)
          }
        }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) { NoticeStack() }
    .sheet(isPresented: $store.showSettings) { SettingsSheet() }
    .confirmationDialog("Snooze", isPresented: Binding(get: { store.snoozing != nil }, set: { if !$0 { store.snoozing = nil } }), presenting: store.snoozing) { card in
      ForEach(SnoozeOption.all(card)) { option in
        Button(option.label) { store.act(card.id, name: card.shortRef, "snooze", snooze: option) }
      }
    }
  }
}

struct ListPage: View {
  @Environment(Store.self) private var store

  var body: some View {
    @Bindable var store = store
    Group {
      switch store.page {
      case .inbox: InboxList()
      case .blocked: BlockedList()
      case .merging: MergingList()
      case .archive: ArchiveList()
      }
    }
    .background(Theme.sheet)
    .navigationTitle(store.page.name)
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(Theme.paper, for: .navigationBar)
    .toolbarBackground(.visible, for: .navigationBar)
    .toolbar {
      // The page's name is the menu at the leading edge; the title itself only names the way back from an opened item.
      ToolbarItem(placement: .principal) { Text("") }
      ToolbarItem(placement: .topBarLeading) {
        Menu {
          Picker("Page", selection: $store.page) {
            Text(store.inboxCount > 0 ? "Inbox  \(store.inboxCount)" : "Inbox").tag(Page.inbox)
            Text("Blocked").tag(Page.blocked)
          }
          .pickerStyle(.inline)
          .labelsHidden()
          Picker("Page", selection: $store.page) {
            Text("Merging").tag(Page.merging)
            Text("Archive").tag(Page.archive)
          }
          .pickerStyle(.inline)
          .labelsHidden()
        } label: {
          HStack(spacing: 7) {
            Mark().fill(Theme.accentInk).frame(width: 24, height: 24)
            Text(store.page.name).sans(16, 650, tracking: -0.01).foregroundStyle(Theme.ink)
            if store.page == .inbox, store.inboxCount > 0 {
              Text("\(store.inboxCount)").sans(13, 450, tabular: true).foregroundStyle(Theme.pencil)
            }
            Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.pencil)
          }
          .padding(.horizontal, 4)
          .frame(minHeight: 44)
          .contentShape(Rectangle())
        }
        .accessibilityLabel("\(store.page.name), choose a page")
        .accessibilityIdentifier("page-menu")
      }
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          store.showSettings = true
        } label: {
          SettingsIcon().stroke(Theme.pencil, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
            .frame(width: 20, height: 20)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("Settings")
      }
    }
  }
}

// MARK: List pieces

extension View {
  // A row on the sheet, edge to edge, a hairline under it from the text's edge.
  func deskRow() -> some View {
    listRowInsets(EdgeInsets())
      .listRowBackground(Theme.sheet)
      .listRowSeparatorTint(Theme.rule)
      .alignmentGuide(.listRowSeparatorLeading) { _ in Theme.pad }
      .alignmentGuide(.listRowSeparatorTrailing) { $0.width }
  }

  // A heading or a quiet line: on the paper, no hairline of its own.
  func deskLine(_ background: Color = Theme.sheet) -> some View {
    listRowInsets(EdgeInsets()).listRowBackground(background).listRowSeparator(.hidden)
  }

  func deskList() -> some View {
    listStyle(.plain)
      .scrollContentBackground(.hidden)
      .background(Theme.sheet)
      .environment(\.defaultMinListRowHeight, 1)
      .environment(\.defaultMinListHeaderHeight, 1)
  }
}

// A row that opens something: a press tints it as the window's pointer does.
struct RowPress: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.background(configuration.isPressed ? Theme.ink.opacity(0.06) : Color.clear)
  }
}

// A card's row with everything a paired device may do to it: a tap opens it; a swipe or a long press acts.
struct CardLine: View {
  @Environment(Store.self) private var store
  @Environment(\.openURL) private var openURL
  let card: Card
  let variant: RowVariant
  var indent: CGFloat = 0

  var body: some View {
    Button {
      store.path.append(.item(card.id))
    } label: {
      CardRow(card: card, variant: variant, now: store.now).padding(.leading, indent)
    }
    .buttonStyle(RowPress())
    .deskRow()
    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
      if card.inflight != true {
        if card.active {
          Button("Done") { store.act(card.id, name: card.shortRef, "done") }.tint(Theme.accent)
        } else {
          Button("Back on the desk") { store.act(card.id, name: card.shortRef, "restore") }.tint(Theme.accent)
        }
      }
    }
    .swipeActions(edge: .leading, allowsFullSwipe: false) {
      if card.inflight != true {
        Button("Snooze") { store.snoozing = card }.tint(Theme.pencil)
      }
    }
    .contextMenu { CardMenu(card: card) }
  }
}

// A row's menu, in the window's order and words, less what only the desk's own window may do; then its way out to GitHub.
struct CardMenu: View {
  @Environment(Store.self) private var store
  @Environment(\.openURL) private var openURL
  let card: Card

  var body: some View {
    if card.inflight != true {
      if card.active {
        Button("Done") { store.act(card.id, name: card.shortRef, "done") }
      } else {
        Button("Back on the desk") { store.act(card.id, name: card.shortRef, "restore") }
      }
      Menu("Snooze") {
        ForEach(SnoozeOption.times + [SnoozeOption.activity]) { option in
          Button(option.label) { store.act(card.id, name: card.shortRef, "snooze", snooze: option) }
        }
        let waits = SnoozeOption.waits(card)
        if !waits.isEmpty {
          Divider()
          ForEach(waits) { option in
            Button(option.label) { store.act(card.id, name: card.shortRef, "snooze", snooze: option) }
          }
        }
      }
      if !card.mine {
        if card.status == "muted" {
          Button("Unmute") { store.act(card.id, name: card.shortRef, "unmute") }
        } else {
          Button("Mute") { store.act(card.id, name: card.shortRef, "mute") }
        }
      }
      Divider()
    }
    if let url = card.url.flatMap(URL.init(string:)) {
      Button("Open on GitHub") { openURL(url) }
      Button("Copy GitHub link") {
        UIPasteboard.general.string = url.absoluteString
        store.flash("Copied the GitHub link to \(card.shortRef)")
      }
    }
  }
}

// MARK: Inbox

// The main page: Urgent (agents' questions, the sessions that need you and your due reminders first), Standard and FYI,
// each in the desk's order.
struct InboxList: View {
  @Environment(Store.self) private var store

  var body: some View {
    if let view = store.queue {
      let active = view.sessions.filter { $0.status == "active" && !store.leaving.contains($0.id) }
      let cards = { (list: [Card]?) in (list ?? []).filter { !store.leaving.contains($0.id) } }
      let urgent = cards(view.inbox?.urgent)
      let standard = cards(view.inbox?.standard)
      let fyi = cards(view.inbox?.fyi)
      let due = view.notes?.due ?? []
      let open = view.notes?.open ?? []
      let lead = view.inquiries.count + active.count + due.count
      let any = lead + urgent.count + open.count + standard.count + fyi.count > 0
      let first = view.firstPass?.line
      ScrollViewReader { proxy in
        List {
          if let first, any { QuietLine(text: first, size: 14).deskLine() }
          if lead + urgent.count > 0 {
            section("urgent", "Urgent", lead + urgent.count) {
              ForEach(view.inquiries) { q in
                Button {
                  store.path.append(.inquiry(q.id))
                } label: {
                  InquiryRow(q: q, now: store.now)
                }
                .buttonStyle(RowPress()).deskRow()
                .contextMenu { Button("Answer") { store.path.append(.inquiry(q.id)) } }
              }
              ForEach(active) { s in SessionLine(s: s) }
              ForEach(due) { n in NoteRow(n: n, now: store.now).deskRow() }
              ForEach(urgent) { c in CardLine(card: c, variant: .active) }
            }
          }
          if open.count + standard.count > 0 {
            section("standard", "Standard", open.count + standard.count) {
              ForEach(open) { n in NoteRow(n: n, now: store.now).deskRow() }
              ForEach(standard) { c in CardLine(card: c, variant: .active) }
            }
          }
          if !fyi.isEmpty {
            section("fyi", "FYI", fyi.count) {
              ForEach(fyi) { c in CardLine(card: c, variant: .active) }
            }
          }
          if !any {
            if let first { QuietLine(text: first).deskLine() } else { QuietLine(text: "Nothing needs you right now.").deskLine() }
          }
          if let n = view.reviewing, n > 0 {
            QuietLine(
              text: n == 1
                ? "1 more PR reaches you once \(store.agent) has reviewed it."
                : "\(n) more PRs reach you once \(store.agent) has reviewed them.", size: 14
            )
            .deskLine()
          }
        }
        .deskList()
        .refreshable { await store.refresh() }
        #if DEBUG
          .task(id: store.loads) {
            guard let to = store.scrollTo, store.loads > 0 else { return }
            try? await Task.sleep(for: .milliseconds(300))
            proxy.scrollTo(to, anchor: .top)
          }
        #endif
      }
    } else {
      Waiting()
    }
  }

  @ViewBuilder
  private func section<Rows: View>(_ key: String, _ label: String, _ count: Int, @ViewBuilder rows: () -> Rows) -> some View {
    let open = !store.folded.contains(key)
    Section {
      if open { rows() }
    } header: {
      GroupHead(label: label, count: count, open: open) { store.folded.formSymmetricDifference([key]) }.deskHead().id(key)
    }
  }
}

extension View {
  func deskHead() -> some View { listRowInsets(EdgeInsets()).textCase(nil) }
}

// Before the first answer: bars while it's on its way, the first-sync line on a desk that never synced, and nothing
// at all once the desk turned out to be away (its bubble says so).
struct Waiting: View {
  @Environment(Store.self) private var store

  var body: some View {
    ScrollView {
      if store.offline || store.starting != nil || store.broken != nil {
        Color.clear.frame(height: 1)
      } else if let o = store.overview, o.syncedAt == nil {
        QuietLine(text: "Getting your PRs from GitHub…")
      } else {
        LoadingRows()
      }
    }
    .background(Theme.sheet)
    .refreshable { await store.refresh() }
  }
}

struct SessionLine: View {
  @Environment(Store.self) private var store
  let s: SessionCard

  var body: some View {
    Button {
      store.path.append(.session(s.id))
    } label: {
      SessionRow(s: s, now: store.now)
    }
    .buttonStyle(RowPress())
    .deskRow()
    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
      Button("Done") { store.act(s.id, name: s.name ?? "", "done") }.tint(Theme.accent)
    }
    .contextMenu {
      Button("Done") { store.act(s.id, name: s.name ?? "", "done") }
      // A session snoozes until a time; done brings it back when it moves on.
      Menu("Snooze") {
        ForEach(SnoozeOption.times) { option in
          Button(option.label) { store.act(s.id, name: s.name ?? "", "snooze", snooze: option) }
        }
      }
    }
  }
}

// MARK: Blocked

// What can't move yet, a chain's rows together in the desk's order, each under the PR it needs.
struct BlockedList: View {
  @Environment(Store.self) private var store

  var body: some View {
    if let view = store.queue {
      let cards = (view.sections?.blocked ?? []).filter { !store.leaving.contains($0.id) }
      List {
        if cards.isEmpty {
          QuietLine(text: "Nothing is blocked.").deskLine()
        } else {
          Section {
            ForEach(cards) { c in CardLine(card: c, variant: .blocked, indent: CGFloat(min(c.depth ?? 0, 4)) * 16) }
          } header: {
            GroupHead(label: "Blocked", count: cards.count).deskHead()
          }
        }
      }
      .deskList()
      .refreshable { await store.refresh() }
    } else {
      Waiting()
    }
  }
}

// MARK: Archive

// What's done: your reminders still to come, what you finished and what the world dealt with, then (folded) what's
// snoozed or muted and what your rules hide.
struct ArchiveList: View {
  @Environment(Store.self) private var store

  var body: some View {
    if let view = store.queue {
      let gone = { (list: [Card]) in list.filter { !store.leaving.contains($0.id) } }
      let later = view.notes?.later ?? []
      let archive = gone(Lists.archive(view))
      let cleared = gone(Lists.cleared(view))
      let hidden = gone(view.hidden)
      List {
        if later.isEmpty && archive.isEmpty && cleared.isEmpty && hidden.isEmpty {
          QuietLine(text: "Nothing here yet: what you finish, and what's dealt with, lands here.").deskLine()
        }
        if !later.isEmpty {
          Section {
            ForEach(later) { n in NoteRow(n: n, now: store.now).deskRow() }
          } header: {
            GroupHead(label: "Reminders", count: later.count).deskHead()
          }
        }
        group("archive", "Archive", archive) { Lists.archiveNote($0) }
        group("cleared", "Snoozed or muted", cleared) { Words.clearedText($0, now: store.now) }
        group("hidden", "Hidden by rules", hidden) { Lists.hiddenNote($0) }
      }
      .deskList()
      .refreshable { await store.refresh() }
    } else {
      Waiting()
    }
  }

  @ViewBuilder
  private func group(_ key: String, _ label: String, _ cards: [Card], note: @escaping (Card) -> String) -> some View {
    if !cards.isEmpty {
      let open = !store.folded.contains(key)
      Section {
        if open { ForEach(cards) { c in CardLine(card: c, variant: .note(note(c))) } }
      } header: {
        GroupHead(label: label, count: cards.count, open: open) { store.folded.formSymmetricDifference([key]) }.deskHead()
      }
    }
  }
}

// MARK: Merging

// Your PRs handed off for merge: how your agent is, what each PR waits on with the agent's latest note, then what landed.
struct MergingList: View {
  @Environment(Store.self) private var store
  @Environment(\.openURL) private var openURL

  var body: some View {
    Group {
      if let view = store.inflight {
        let live = view.rows.filter { $0.state == "open" }
        let landed = view.rows.filter { $0.state != "open" }
        List {
          if let c = view.coordinator { agentLine(c).deskLine() }
          if live.isEmpty {
            QuietLine(text: "Nothing in Merging yet: hand off one of your PRs for merge when you're done with it.").deskLine()
          }
          ForEach(parts(live), id: \.first?.id) { part in
            // The desk sends a stack's rows together, bottom first: two or more sit under one quiet line.
            if part.count > 1, let s = part[0].card.stack {
              Text("Stack on \(s.id.flatMap { view.stacks?[$0]?.base } ?? "its base") · \(s.size ?? part.count) open")
                .sans(13).foregroundStyle(Theme.pencil)
                .padding(.init(top: 12, leading: Theme.pad, bottom: 2, trailing: Theme.pad))
                .frame(maxWidth: .infinity, alignment: .leading)
                .deskLine()
            }
            ForEach(part) { row in line(row) }
          }
          if !landed.isEmpty {
            Section {
              ForEach(landed) { row in line(row) }
            } header: {
              GroupHead(label: "Merged", count: landed.count).deskHead()
            }
          }
        }
        .deskList()
        .refreshable { await store.refresh() }
      } else {
        Waiting()
      }
    }
    .task { await store.openMerging() }
  }

  private func parts(_ rows: [InflightView.Row]) -> [[InflightView.Row]] {
    var out: [[InflightView.Row]] = []
    for r in rows {
      if let stack = r.card.stack?.id, let last = out.last, last[0].card.stack?.id == stack {
        out[out.count - 1].append(r)
      } else {
        out.append([r])
      }
    }
    return out
  }

  private func line(_ row: InflightView.Row) -> some View {
    Button {
      store.path.append(.item(row.card.id))
    } label: {
      MergingRow(row: row, now: store.now)
    }
    .buttonStyle(RowPress())
    .deskRow()
    .contextMenu { CardMenu(card: row.card) }
  }

  // One quiet line: how your agent is, and where to watch it. Waking it and attaching to it are the desk's computer's.
  @ViewBuilder
  private func agentLine(_ c: InflightView.Coordinator) -> some View {
    Group {
      if c.on != true {
        Text("Your agent is off in Settings → Agent.").foregroundStyle(Theme.pencil)
      } else if let error = c.error, !error.isEmpty {
        Lead(label: "Your agent can't run:", text: error, labelColor: Theme.red)
      } else if c.id == nil {
        Text("Your agent starts on your first hand-off or ask.").foregroundStyle(Theme.pencil)
      } else {
        HStack(spacing: 0) {
          Text("Your agent").foregroundStyle(Theme.pencil)
          if let url = c.url.flatMap(URL.init(string:)) {
            Text("·").foregroundStyle(Theme.faint).padding(.horizontal, 6)
            Button {
              openURL(url)
            } label: {
              Text("Watch on claude.ai").underline(color: Theme.ruleStrong).foregroundStyle(Theme.ink2)
            }
            .buttonStyle(.plain)
          }
        }
      }
    }
    .sans(13)
    .padding(.init(top: 18, leading: Theme.pad, bottom: 12, trailing: Theme.pad))
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}
