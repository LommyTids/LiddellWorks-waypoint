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
                WelcomeView()
            }
        }
        .tint(WayPointStyle.teal)
        .task { await model.start() }
        .alert("WayPoint", isPresented: Binding(
            get: { model.workspace != nil && model.message != nil },
            set: { if !$0 { model.message = nil } }
        )) {
            Button("OK", role: .cancel) { model.message = nil }
        } message: {
            Text(model.message ?? "")
        }
    }
}

private struct TripsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showNewTrip = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 6) {
                    WayPointBrand()
                    Text(model.isDemo ? "A little inspiration" : "Hello, \(model.accountName)")
                        .font(WayPointType.heading)
                        .foregroundStyle(WayPointStyle.navy)
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
                            .accessibilityIdentifier("trip-" + trip.id)
                        }
                    }
                }
            }
            .padding(20)
            .frame(maxWidth: 860)
            .frame(maxWidth: .infinity)
        }
        .background(WayPointStyle.canvas)
        .navigationTitle("Your trips")
        .sheet(isPresented: $showNewTrip) { NavigationStack { NewTripView() } }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showNewTrip = true } label: { Label("New trip", systemImage: "plus") }
                    .tint(WayPointStyle.amber)
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
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: "globe.europe.africa.fill")
                    .font(.system(size: 24))
                    .foregroundStyle(WayPointStyle.teal)
                    .padding(10)
                    .background(WayPointStyle.teal.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 7) {
                    Text(trip.name).font(WayPointType.heading).foregroundStyle(WayPointStyle.navy)
                    Text(LocalTripDate.range(start: trip.startDate, end: trip.endDate))
                        .font(WayPointType.meta).foregroundStyle(WayPointStyle.muted)
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
                    .font(.caption.weight(.semibold)).foregroundStyle(WayPointStyle.amber)
            }
        }
        .padding(16)
        .atlasCard(cornerRadius: 12)
        .accessibilityElement(children: .combine)
    }
}

private struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showSignOut = false

    var body: some View {
        Form {
            Group {
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
            .listRowBackground(WayPointStyle.surface)
        }
        .atlasForm()
        .navigationTitle("Settings")
        .confirmationDialog(model.isDemo ? "Leave the demo?" : "Sign out of WayPoint?", isPresented: $showSignOut, titleVisibility: .visible) {
            Button(model.isDemo ? "Leave demo" : "Sign out", role: .destructive) { Task { await model.signOut() } }
        } message: {
            Text("Your saved drafts will stay on this device for your next sign-in to the same account.")
        }
    }
}
