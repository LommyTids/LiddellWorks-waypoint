import AuthenticationServices
import SwiftUI

struct WelcomeView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    WayPointBrand()
                    VStack(alignment: .leading, spacing: 22) {
                        Image("WayPointMark")
                            .resizable().scaledToFit().frame(maxHeight: 110)
                            .frame(maxWidth: .infinity)
                            .accessibilityHidden(true)
                        Text("Every journey.\nOne shared adventure.")
                            .font(WayPointType.display)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("Bring every stop, stay and plan together. Keep your itinerary close, wherever the trip takes you.")
                            .font(WayPointType.body).foregroundStyle(.white.opacity(0.85))
                    }
                    .foregroundStyle(.white)
                    .padding(26)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(WayPointStyle.brandBlue, in: RoundedRectangle(cornerRadius: 28))

                    VStack(alignment: .leading, spacing: 18) {
                        feature("Your people, your plans", detail: "See who’s joining each part of the journey.", symbol: "person.2")
                        feature("Ready to go offline", detail: "Downloaded plans and saved places travel with you.", symbol: "suitcase.rolling")
                    }
                    if let message = model.message { AuthErrorNotice(message: message) }
                }
                .padding(24)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .background(WayPointStyle.canvas)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 12) {
                    NavigationLink {
                        SignInView()
                    } label: {
                        Text("Log in to WayPoint").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(AtlasButtonStyle())
                    .disabled(model.isBusy)
                    Button { model.enterDemo() } label: {
                        Label("Explore a demo trip", systemImage: "arrow.up.right")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(AtlasButtonStyle(role: .selection))
                    .disabled(model.isBusy)
                    if model.isBusy {
                        ProgressView("Restoring your account…")
                            .font(.footnote).foregroundStyle(WayPointStyle.muted)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 14)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
                .background(WayPointStyle.canvas)
            }
            .toolbar(.hidden, for: .navigationBar)
        }
    }

    private func feature(_ title: String, detail: String, symbol: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol).font(.title3)
                .foregroundStyle(WayPointStyle.teal)
                .frame(width: 44, height: 44)
                .background(WayPointStyle.tealSoft, in: RoundedRectangle(cornerRadius: 12))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(WayPointType.label).foregroundStyle(WayPointStyle.navy)
                Text(detail).font(WayPointType.body).foregroundStyle(WayPointStyle.muted)
            }
        }
    }
}

struct SignInView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var phone = ""
    @State private var showHelp = false
    @FocusState private var codeFocused: Bool

    /// The phone form is the fallback: it stays until the server says it has ended.
    private var showsPhone: Bool { model.signInOptions?.phoneLogin ?? true }
    private var providerNames: String? { model.signInOptions?.providerNames }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                WayPointBrand()
                VStack(alignment: .leading, spacing: 10) {
                    Text("Welcome back.")
                        .font(.custom("Fraunces-SemiBold", size: 34, relativeTo: .largeTitle))
                        .foregroundStyle(WayPointStyle.navy)
                    Text("Your next adventure is waiting.")
                        .font(WayPointType.body).foregroundStyle(WayPointStyle.muted)
                }
                VStack(alignment: .leading, spacing: 20) {
                    Text("Log in to your account").font(WayPointType.label).foregroundStyle(WayPointStyle.navy)
                    if let options = model.signInOptions { providerButtons(options) }
                    if providerNames != nil && showsPhone { OrDivider() }
                    if showsPhone { phoneField }
                    if let message = model.message { AuthErrorNotice(message: message) }
                    if showsPhone {
                        phoneSubmit
                    } else if model.isBusy {
                        ProgressView("Connecting…")
                            .font(.footnote).foregroundStyle(WayPointStyle.muted)
                            .frame(maxWidth: .infinity)
                    }
                    Button("Need help logging in?") { codeFocused = false; showHelp = true }
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .padding(24)
                .atlasCard()
                Label("Your downloaded trips will be available offline after login.", systemImage: "internaldrive")
                    .font(.footnote).foregroundStyle(WayPointStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(24)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .background(WayPointStyle.canvas)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Log in")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .navigationBarBackButtonHidden(model.isBusy)
        .task {
            // A nonce lasts ten minutes, and Apple's button cannot wait for a new one.
            while !Task.isCancelled {
                let ready = await model.prepareSignIn()
                try? await Task.sleep(for: .seconds(ready ? 540 : 30))
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { codeFocused = false }
            }
        }
        .sheet(isPresented: $showHelp) {
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        Text("Let’s get you back to your plans.")
                            .font(WayPointType.heading)
                            .foregroundStyle(WayPointStyle.navy)
                        if let providerNames {
                            Text("Sign in with the \(providerNames) account linked to your WayPoint account.")
                            Text("New to WayPoint? Open your invite link in Safari first, then come back and sign in with the same account.")
                        }
                        if showsPhone {
                            Text("Use the same registered phone number you use to log in at liddellworks.com/WayPoint.")
                        }
                        Text("Don’t have an account or need your login details changed? Ask the site owner to set up or update your account.")
                        Text("If WayPoint can’t connect, check your internet connection and try again. Your saved drafts stay on this device.")
                    }
                    .foregroundStyle(WayPointStyle.muted)
                    .padding(24)
                }
                .background(WayPointStyle.canvas)
                .navigationTitle("Login help")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showHelp = false } } }
            }
            .presentationDetents([.medium, .large])
        }
    }

    @ViewBuilder
    private func providerButtons(_ options: SignInOptions) -> some View {
        if options.appleNonce != nil {
            // No scopes: WayPoint keeps only Apple's identifier, not a name or email.
            SignInWithAppleButton(.signIn) { request in
                request.requestedScopes = []
                request.nonce = model.signInOptions?.appleNonce
            } onCompletion: { finishAppleSignIn($0) }
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            .frame(height: 48)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .disabled(model.isBusy)
            .accessibilityIdentifier("sign-in-apple")
        }
        if options.googleClientID != nil {
            Button {
                codeFocused = false
                Task {
                    await model.signInWithGoogle { url, scheme in
                        try await webAuthenticationSession.authenticate(using: url, callbackURLScheme: scheme)
                    }
                }
            } label: {
                HStack(spacing: 10) {
                    Image("GoogleMark").resizable().frame(width: 20, height: 20).accessibilityHidden(true)
                    Text("Sign in with Google")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(GoogleButtonStyle())
            .disabled(model.isBusy)
            .accessibilityIdentifier("sign-in-google")
        }
    }

    private func finishAppleSignIn(_ result: Result<ASAuthorization, Error>) {
        switch result {
        case .failure(let error): model.appleSignInFailed(error)
        case .success(let authorization):
            let credential = authorization.credential as? ASAuthorizationAppleIDCredential
            guard let data = credential?.identityToken, let token = String(data: data, encoding: .utf8) else {
                return model.appleSignInFailed(ASAuthorizationError(.failed))
            }
            Task { await model.signIn(provider: .apple, idToken: token) }
        }
    }

    private var phoneField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Enter login code here").font(.subheadline.weight(.medium))
                .foregroundStyle(WayPointStyle.navy)
            TextField("Enter login code here", text: $phone)
                .textContentType(.telephoneNumber)
                .keyboardType(.phonePad)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($codeFocused)
                .padding(14)
                .frame(minHeight: 52)
                .background(WayPointStyle.canvas, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12)
                    .stroke(codeFocused ? WayPointStyle.teal : WayPointStyle.line, lineWidth: codeFocused ? 2 : 1))
                .accessibilityLabel("Enter login code here")
                .accessibilityHint("Use the registered phone number for your WayPoint website account")
                .disabled(model.isBusy)
                .accessibilityIdentifier("login-code")
            Text("Use the registered phone number for your existing WayPoint website account.")
                .font(.footnote).foregroundStyle(WayPointStyle.muted)
        }
    }

    private var phoneSubmit: some View {
        Button {
            codeFocused = false
            Task { await model.signIn(phone: phone) }
        } label: {
            HStack(spacing: 10) {
                if model.isBusy { ProgressView().tint(.white) }
                Text(model.isBusy ? "Connecting…" : "Log in")
                if !model.isBusy { Image(systemName: "arrow.right") }
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(AtlasButtonStyle())
        .disabled(model.isBusy || phone.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .accessibilityIdentifier("login-submit")
    }
}

private struct OrDivider: View {
    var body: some View {
        HStack(spacing: 12) {
            Rectangle().fill(WayPointStyle.line).frame(height: 1)
            Text("or").font(.footnote).foregroundStyle(WayPointStyle.muted)
            Rectangle().fill(WayPointStyle.line).frame(height: 1)
        }
        .accessibilityHidden(true)
    }
}

/// Google's published button colours, which its branding rules ask for in place
/// of the app's own.
private struct GoogleButtonStyle: ButtonStyle {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let dark = colorScheme == .dark
        configuration.label
            .font(.body.weight(.medium))
            .foregroundStyle(dark ? Color(red: 0.89, green: 0.89, blue: 0.89) : Color(red: 0.12, green: 0.12, blue: 0.12))
            .padding(.horizontal, 16)
            .frame(minHeight: 48)
            .background(dark ? Color(red: 0.07, green: 0.07, blue: 0.08) : .white, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14)
                .stroke(dark ? Color(red: 0.56, green: 0.57, blue: 0.56) : Color(red: 0.45, green: 0.47, blue: 0.46), lineWidth: 1))
            .opacity(isEnabled ? (configuration.isPressed ? 0.75 : 1) : 0.45)
    }
}

private struct AuthErrorNotice: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.circle")
            .font(.subheadline)
            .foregroundStyle(WayPointStyle.danger)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel("Login error: \(message)")
    }
}
