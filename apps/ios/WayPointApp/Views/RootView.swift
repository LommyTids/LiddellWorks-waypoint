import SwiftUI
import WayPointCore

struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Group {
            if model.workspace != nil {
                TabView {
                    NavigationStack { TripsView() }
                        .tabItem { Label("Trips", systemImage: "map") }
                    NavigationStack { SettingsView() }
                        .tabItem { Label("Settings", systemImage: "gearshape") }
                }
            } else {
                SignInView()
            }
        }
        .tint(WayPointStyle.teal)
        .task { await model.start() }
        .alert("WayPoint", isPresented: Binding(
            get: { model.message != nil },
            set: { if !$0 { model.message = nil } }
        )) {
            Button("OK", role: .cancel) { model.message = nil }
        } message: {
            Text(model.message ?? "")
        }
    }
}

private struct SignInView: View {
    @EnvironmentObject private var model: AppModel
    @State private var username = ""
    @State private var password = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                Image(systemName: "point.topleft.down.curvedto.point.bottomright.up")
                    .font(.system(size: 48, weight: .medium))
                    .foregroundStyle(WayPointStyle.teal)
                    .padding(.top, 32)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 10) {
                    Text("WayPoint").font(.largeTitle.bold())
                    Text("Every stop. One trip.")
                        .font(.title2.weight(.medium))
                    Text("Bring your travel plans with you. Download your trips, explore places with Apple Maps, and save changes offline until you can sync.")
                        .foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 16) {
                    Text("Your WayPoint account").font(.headline)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Username").font(.subheadline)
                        TextField("Username", text: $username)
                            .textContentType(.username)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textFieldStyle(.roundedBorder)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Password").font(.subheadline)
                        SecureField("Password", text: $password)
                            .textContentType(.password)
                            .textFieldStyle(.roundedBorder)
                    }
                    Button {
                        Task { await model.signIn(username: username.trimmingCharacters(in: .whitespacesAndNewlines), password: password) }
                    } label: {
                        HStack {
                            if model.isBusy { ProgressView().tint(.white) }
                            Text(model.isBusy ? "Connecting…" : "Sign in").fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.isBusy || username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty)
                }
                .padding(22)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 22))

                Button { model.enterDemo() } label: {
                    Label("Explore a demo trip", systemImage: "play.circle")
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.bordered)
                .disabled(model.isBusy)
                Text("Sign in with the same username and password you use at liddellworks.com/WayPoint.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(24)
            .frame(maxWidth: 500)
            .frame(maxWidth: .infinity)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }
}

private struct TripsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showNewTrip = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(model.isDemo ? "A little inspiration" : "Hello, \(model.accountName)")
                        .font(.title2.bold())
                    Text(model.isDemo ? "Explore a sample itinerary and try an offline edit." : "Your places, plans, and moments ahead.")
                        .foregroundStyle(.secondary)
                }
                DraftNotice(isDemo: model.isDemo)
                if model.trips.isEmpty {
                    ContentUnavailableView("No trips yet", systemImage: "suitcase.rolling", description: Text("Tap the plus button to plan your first trip."))
                } else {
                    LazyVStack(spacing: 16) {
                        ForEach(model.trips) { trip in
                            NavigationLink {
                                TripDetailView(tripID: trip.id)
                            } label: {
                                TripCard(trip: trip, draftCount: model.workspace?.mutations.filter { $0.tripID == trip.id }.count ?? 0)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(20)
            .frame(maxWidth: 860)
            .frame(maxWidth: .infinity)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("Your trips")
        .sheet(isPresented: $showNewTrip) { NavigationStack { NewTripView() } }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showNewTrip = true } label: { Label("New trip", systemImage: "plus") }
                    .disabled(model.isBusy)
            }
            ToolbarItem(placement: .topBarTrailing) {
                if model.isBusy {
                    ProgressView().accessibilityLabel("Syncing trips")
                } else if !model.isDemo {
                    Button { Task { await model.refresh() } } label: {
                        Label("Sync now", systemImage: "arrow.clockwise")
                    }
                    .disabled(!model.canRefresh)
                }
            }
        }
        .refreshable { if model.canRefresh && !model.isBusy { await model.refresh() } }
    }
}

private struct TripCard: View {
    let trip: TripSnapshot
    let draftCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: "globe.europe.africa.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(WayPointStyle.teal)
                    .padding(14)
                    .background(WayPointStyle.teal.opacity(0.10), in: RoundedRectangle(cornerRadius: 18))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 7) {
                    Text(trip.name).font(.title3.bold()).foregroundStyle(.primary)
                    Text(LocalTripDate.range(start: trip.startDate, end: trip.endDate))
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
            HStack(spacing: 12) {
                Label("\(trip.records.count) plans", systemImage: "list.bullet")
                Spacer()
                Text(trip.role.displayTitle)
            }
            .font(.caption.weight(.medium)).foregroundStyle(.secondary)
            if draftCount > 0 {
                Label("\(draftCount) pending change\(draftCount == 1 ? "" : "s")", systemImage: "pencil.circle")
                    .font(.caption.weight(.semibold)).foregroundStyle(.orange)
            }
        }
        .padding(20)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 22))
        .accessibilityElement(children: .combine)
    }
}

private struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showSignOut = false

    var body: some View {
        Form {
            Section("Account") {
                LabeledContent("Signed in as", value: model.accountName)
                LabeledContent("Mode", value: model.isDemo ? "Local demo" : "WayPoint account")
                if !model.isDemo {
                    LabeledContent("Server", value: URL(string: WayPointAPI.origin)?.host ?? WayPointAPI.origin)
                }
            }
            Section {
                LabeledContent("Local changes", value: "\(model.pendingCount)")
                if let lastRefresh = model.workspace?.lastRefresh {
                    LabeledContent("Last sync") {
                        Text(lastRefresh, format: .dateTime.day().month(.abbreviated).hour().minute())
                    }
                }
                if !model.isDemo {
                    Button { Task { await model.refresh() } } label: {
                        Label(model.isBusy ? "Syncing…" : "Sync now", systemImage: "arrow.clockwise")
                    }
                    .disabled(!model.canRefresh || model.isBusy)
                }
            } header: {
                Text("Offline storage & sync")
            } footer: {
                Text(model.isDemo ? "Demo trips and changes stay on this device. Sign in to your existing WayPoint account to try sync." : "Saved trips work offline. Changes are queued on this device and sent to WayPoint when you tap Sync now. Conflicts stay here until you review them.")
            }
            if let mutations = model.workspace?.mutations, !mutations.isEmpty {
                Section("Pending changes") {
                    ForEach(mutations) { mutation in
                        NavigationLink { PendingChangeView(mutationID: mutation.id) } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(mutation.record?.title ?? "Trip or removed item").font(.subheadline.weight(.semibold))
                                Text(mutation.status == .conflict ? "Needs review" : mutation.status == .blocked ? "Blocked" : "Waiting to sync")
                                    .font(.caption).foregroundStyle(.orange)
                                if let message = mutation.message { Text(message).font(.caption).foregroundStyle(.secondary) }
                            }
                        }
                    }
                }
            }
            Section("Maps") {
                Label("Places powered by Apple Maps", systemImage: "map")
                Text("Place search and map imagery need an internet connection. Saved addresses and coordinates remain in your downloaded trips.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section {
                Button(model.isDemo ? "Leave demo" : "Sign out", role: .destructive) { showSignOut = true }
                    .disabled(model.isBusy)
            } footer: {
                Text("Signing out keeps drafts on this device for your next sign-in to the same account.")
            }
            Section {
                LabeledContent("WayPoint", value: "iOS production sync")
            }
        }
        .navigationTitle("Settings")
        .confirmationDialog(model.isDemo ? "Leave the demo?" : "Sign out of WayPoint?", isPresented: $showSignOut, titleVisibility: .visible) {
            Button(model.isDemo ? "Leave demo" : "Sign out", role: .destructive) { Task { await model.signOut() } }
        } message: {
            Text("Your saved drafts will stay on this device for your next sign-in to the same account.")
        }
    }
}
