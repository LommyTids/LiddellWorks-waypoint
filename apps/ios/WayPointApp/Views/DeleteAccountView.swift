import AuthenticationServices
import SwiftUI

/// The last stop before an account goes. Nothing is removed until the person has
/// read what will happen, typed the confirmation and pressed the final button.
struct DeleteAccountView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var summary: AccountDeletionSummary?
    @State private var failure: String?
    @State private var confirmation = ""
    @FocusState private var confirmationFocused: Bool

    private var canConfirm: Bool { AccountDeletionSummary.isConfirmed(confirmation) && !model.isBusy }

    var body: some View {
        Form {
            Group {
                if let summary {
                    details(summary)
                } else if failure == nil {
                    ProgressView("Checking your account…").frame(maxWidth: .infinity)
                } else {
                    Button("Try again") { Task { await load() } }
                }
                if let failure {
                    Label(failure, systemImage: "exclamationmark.circle")
                        .font(.subheadline)
                        .foregroundStyle(WayPointStyle.danger)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("delete-account-failure")
                }
            }
            .listRowBackground(WayPointStyle.surface)
        }
        .atlasForm()
        .navigationTitle("Delete account")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(model.isBusy)
        .scrollDismissesKeyboard(.interactively)
        .task { await load() }
    }

    @ViewBuilder
    private func details(_ summary: AccountDeletionSummary) -> some View {
        if let blocked = summary.blocked {
            Section { Text(blocked).accessibilityIdentifier("delete-account-blocked") }
        } else {
            Section("What happens") {
                ForEach(summary.consequences(pendingChanges: model.pendingCount), id: \.self) { line in
                    Text(line).fixedSize(horizontal: false, vertical: true)
                }
            }
            Section("Type DELETE to confirm") {
                TextField("DELETE", text: $confirmation)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .focused($confirmationFocused)
                    .disabled(model.isBusy)
                    .accessibilityLabel("Type DELETE to confirm")
                    .accessibilityIdentifier("delete-account-confirmation")
            }
            if summary.confirmsWithApple { appleActions } else { plainAction }
            if model.isBusy {
                ProgressView("Deleting your account…").frame(maxWidth: .infinity)
            }
        }
    }

    private var plainAction: some View {
        Section {
            Button("Delete account", role: .destructive) { delete() }
                .disabled(!canConfirm)
                .accessibilityIdentifier("delete-account-submit")
        }
    }

    /// No scopes and no nonce: only the single-use code is needed, and the server
    /// spends it with Apple straight away.
    private var appleActions: some View {
        Section {
            SignInWithAppleButton(.continue) { request in
                request.requestedScopes = []
            } onCompletion: { finishApple($0) }
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            .frame(height: 48)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .disabled(!canConfirm)
            .opacity(canConfirm ? 1 : 0.45)
            .accessibilityIdentifier("delete-account-apple")
            Button("Delete without Apple", role: .destructive) { delete() }
                .disabled(!canConfirm)
                .accessibilityIdentifier("delete-account-submit")
        } footer: {
            Text("Apple asks you to confirm, then WayPoint’s access to your Apple ID ends. If you can’t use that Apple ID, delete without Apple and remove WayPoint in Settings afterwards.")
        }
    }

    private func load() async {
        failure = nil
        do { summary = try await model.accountDeletionSummary() }
        catch { failure = error.localizedDescription }
    }

    private func finishApple(_ result: Result<ASAuthorization, Error>) {
        switch result {
        case .failure(let error):
            guard (error as? ASAuthorizationError)?.code != .canceled else { return }
            failure = "Apple couldn’t confirm it’s you. Try again, or delete without Apple."
        case .success(let authorization):
            let credential = authorization.credential as? ASAuthorizationAppleIDCredential
            guard let data = credential?.authorizationCode, let code = String(data: data, encoding: .utf8) else {
                failure = "Apple couldn’t confirm it’s you. Try again, or delete without Apple."
                return
            }
            delete(appleCode: code)
        }
    }

    private func delete(appleCode: String? = nil) {
        guard let summary else { return }
        failure = nil
        confirmationFocused = false
        Task {
            do { try await model.deleteAccount(summary: summary, appleAuthorizationCode: appleCode) }
            catch APIError.server(let reason) { failure = reason }
            catch { failure = "WayPoint didn’t confirm the deletion. Check your connection and try again." }
        }
    }
}
