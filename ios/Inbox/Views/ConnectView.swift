import SwiftUI

// The first screen while no desk is saved: the desk's address and, over Tailscale, the pairing code from `desk pair`.
struct ConnectView: View {
  @Environment(Store.self) private var store
  @State private var typed = ""
  @State private var code = ""
  @State private var error: String?
  @State private var busy = false
  @FocusState private var focus: Field?

  private enum Field { case address, code }

  // What's typed so far: a localhost address needs no code, and a pasted pairing link carries its own.
  private var parsed: (address: DeskAddress, code: String?)? {
    if case .success(let p) = DeskAddress.parse(typed) { p } else { nil }
  }
  private var asksCode: Bool { !(parsed?.address.isLocal ?? false) && parsed?.code == nil }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 9) {
          Mark().fill(Theme.accentInk).frame(width: 28, height: 28)
          Text("Inbox").sans(17, 650, tracking: -0.01).foregroundStyle(Theme.ink)
        }
        .padding(.bottom, 28)

        Text("Connect to your desk").sans(22, 650, tracking: -0.015).foregroundStyle(Theme.ink)
        Text("Your desk runs on your computer. This phone reaches it over Tailscale and shows what's on it.")
          .sans(15).foregroundStyle(Theme.pencil).lineSpacing(3)
          .padding(.top, 8).padding(.bottom, 24)

        if let note = store.connectNote {
          Text(note).sans(14).foregroundStyle(Theme.red).lineSpacing(2).padding(.bottom, 16)
        }

        label("Desk address")
        field("https://machine.tailnet.ts.net", text: $typed, mono: false)
          .textContentType(.URL).keyboardType(.URL)
          .focused($focus, equals: .address)
          .submitLabel(asksCode ? .next : .go)
          .onSubmit { if asksCode { focus = .code } else { connect() } }

        if asksCode {
          label("Pairing code").padding(.top, 16)
          field("XXXX-XXXX", text: $code, mono: true)
            .textInputAutocapitalization(.characters)
            .focused($focus, equals: .code)
            .submitLabel(.go)
            .onSubmit(connect)
          Prose(text: "Run `desk pair` on the desk's computer for the address and a code. A code works once, for 10 minutes.")
            .foregroundStyle(Theme.pencil).lineSpacing(2).padding(.top, 8)
        } else if parsed?.address.isLocal == true {
          Text("A desk on this computer needs no code.").sans(13).foregroundStyle(Theme.pencil).padding(.top, 8)
        } else {
          Text("That's a pairing link: its code comes with it.").sans(13).foregroundStyle(Theme.pencil).padding(.top, 8)
        }

        if let error {
          Text(error).sans(14).foregroundStyle(Theme.red).lineSpacing(2).padding(.top, 16)
            .accessibilityIdentifier("connect-error")
        }

        Button(action: connect) {
          HStack(spacing: 8) {
            if busy { ProgressView().controlSize(.small).tint(Theme.onAccent) }
            Text(busy ? "Connecting…" : "Connect").sans(15, 600)
          }
          .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(FilledButton())
        .disabled(busy || typed.trimmingCharacters(in: .whitespaces).isEmpty)
        .padding(.top, 24)
      }
      .padding(.horizontal, 24)
      .padding(.top, 56)
      .frame(maxWidth: 520, alignment: .leading)
    }
    .scrollDismissesKeyboard(.interactively)
    .background(Theme.paper.ignoresSafeArea())
    .onAppear { if typed.isEmpty { typed = store.lastAddress } }
  }

  private func label(_ words: String) -> some View {
    Text(words).sans(13, 550).foregroundStyle(Theme.ink2).padding(.bottom, 6)
  }

  private func field(_ placeholder: String, text: Binding<String>, mono: Bool) -> some View {
    TextField("", text: text, prompt: Text(placeholder).foregroundStyle(Theme.faint))
      .modifier(FieldFace(mono: mono))
      .foregroundStyle(Theme.ink)
      .textInputAutocapitalization(.never)
      .autocorrectionDisabled()
      .padding(.horizontal, 12)
      .frame(minHeight: 44)
      .background(Theme.sheet, in: RoundedRectangle(cornerRadius: 8))
      .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.ruleStrong, lineWidth: 1))
  }

  private func connect() {
    guard !busy else { return }
    busy = true
    error = nil
    focus = nil
    Task {
      // Only a code field that's on screen is sent.
      error = await store.connect(typed: typed, code: asksCode ? code : "")
      busy = false
    }
  }
}

private struct FieldFace: ViewModifier {
  let mono: Bool
  func body(content: Content) -> some View {
    if mono { content.mono(16) } else { content.sans(16) }
  }
}

// The one call to action to press: filled with the accent.
struct FilledButton: ButtonStyle {
  @Environment(\.isEnabled) private var enabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .foregroundStyle(enabled ? Theme.onAccent : Theme.pencil)
      .background(enabled ? Theme.accent : Theme.sheet, in: RoundedRectangle(cornerRadius: 9))
      .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(enabled ? Color.clear : Theme.ruleStrong, lineWidth: 1))
      .opacity(configuration.isPressed ? 0.88 : 1)
  }
}
