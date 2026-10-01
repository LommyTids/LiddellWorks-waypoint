import Foundation
import Combine
import WayPointCore

/// Coordinates account identity, durable state and foreground sync. A disk save
/// precedes both UI publication and every potentially committed network mutation.
@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var workspace: LocalWorkspace?
    @Published private(set) var isBusy = false
    @Published var message: String?
    @Published private(set) var isDemo = false

    private var store: WorkspaceStore?
    private let keychain = KeychainSessionStore()
    private let api = WayPointAPI()
    private var session: SavedSession?
    private var d1: D1Workspace?
    private var hasStarted = false
    private var storageFailure: String?

    var trips: [TripSnapshot] { workspace?.trips ?? [] }
    var pendingCount: Int { isDemo ? workspace?.mutations.count ?? 0 : d1?.outbox.count ?? 0 }
    var accountName: String { workspace?.account.username ?? "" }
    var canRefresh: Bool { !isDemo && session != nil && !isBusy }

    init() {
        do { store = try WorkspaceStore() }
        catch { storageFailure = "Could not open offline storage: \(error.localizedDescription)" }
    }

    func start() async {
        guard !hasStarted else { return }
        hasStarted = true
        guard storageFailure == nil, let store else { message = storageFailure; return }
        do {
            guard let saved = try keychain.read() else { return }
            try saved.validate()
            let cached = try store.loadD1(accountID: saved.account.id, as: D1Workspace.self)
            guard cached == nil || cached?.account.id == saved.account.id else { throw APIError.unauthorized }
            d1 = cached ?? D1Workspace(account: saved.account)
            session = saved
            // Do not publish the private cache before online identity validation.
            await refresh()
        } catch {
            session = nil; workspace = nil; d1 = nil
            message = error.localizedDescription
        }
    }

    func enterDemo() {
        guard !isBusy, let store else { message = storageFailure; return }
        do {
            let demo = try store.load(accountID: DemoData.workspace.account.id) ?? DemoData.workspace
            try store.save(demo)
            session = nil; d1 = nil; isDemo = true; workspace = demo; message = nil
        } catch { message = error.localizedDescription }
    }

    func signIn(username: String, password: String) async {
        guard !isBusy, let store else { message = storageFailure; return }
        isBusy = true; message = nil
        defer { isBusy = false }
        do {
            let saved = try await api.login(username: username, password: password)
            _ = try await api.whoAmI(session: saved)
            let cached = try store.loadD1(accountID: saved.account.id, as: D1Workspace.self)
            guard cached == nil || cached?.account.id == saved.account.id else { throw APIError.unauthorized }
            d1 = cached ?? D1Workspace(account: saved.account)
            d1?.account = saved.account
            // Store the session only after its account has been validated.
            try keychain.save(saved)
            session = saved; isDemo = false
            try await synchronize(saved: saved)
        } catch APIError.unauthorized { endExpiredSession() }
        catch {
            // Failed synchronization never publishes an incomplete bootstrap.
            message = error.localizedDescription
            if let state = d1, state.cursor != nil { workspace = try? state.presentationWorkspace() }
        }
    }

    func refresh() async {
        guard !isBusy, !isDemo, let saved = session, store != nil else { return }
        isBusy = true; message = nil
        defer { isBusy = false }
        do {
            try saved.validate()
            let account = try await api.whoAmI(session: saved)
            guard account.id == saved.account.id else { throw APIError.unauthorized }
            try await synchronize(saved: saved)
        } catch APIError.unauthorized { endExpiredSession() }
        catch {
            // Only a still-valid session can reopen its own complete offline cache.
            // Cursor nil means authorization was invalidated; do not expose drafts.
            if let state = d1, state.cursor != nil, saved.expiresAt > Date() {
                workspace = try? state.presentationWorkspace()
            }
            message = "Could not finish sync. Saved changes are retained. \(error.localizedDescription)"
        }
    }

    private func synchronize(saved: SavedSession) async throws {
        _ = try await api.capabilities(session: saved)
        try await download(saved: saved)
        var sent = 0
        while sent < 100 {
            guard var state = d1, let mutation = try state.submitNext() else { break }
            try commit(state) // freeze and persist before the network can commit
            let response = try await api.mutations(session: saved, request: D1MutationRequest(mutations: [mutation]))
            // One request at a time: malformed/omitted receipts must remain uncertain.
            guard response.results.count == 1, response.results.first?.mutationId == mutation.mutationId else {
                throw APIError.invalidResponse
            }
            state = d1 ?? state
            try state.apply(response)
            try commit(state)
            sent += 1
        }
        // Acknowledgements contain revisions, not sanitized complete payloads.
        try await download(saved: saved, forceBootstrap: sent > 0)
        if d1?.outbox.contains(where: { $0.status == .conflict || $0.status == .rejected }) == true {
            message = "Some changes need review. Open Settings to compare or discard them."
        } else if sent == 100 {
            message = "Saved this sync batch. Sync again to send remaining changes."
        }
    }

    private func download(saved: SavedSession, forceBootstrap: Bool = false) async throws {
        // Bootstrap can be invalidated while paging. Restart at most three times;
        // retain quarantined drafts if a busy server keeps changing the snapshot.
        for _ in 0..<3 {
            do {
                if let cursor = d1?.cursor, !forceBootstrap {
                    var current = cursor
                    for _ in 0..<10_000 {
                        let page = try await api.changes(session: saved, cursor: current)
                        guard !page.hasMore || page.cursor != current else { throw APIError.invalidResponse }
                        guard var state = d1 else { throw AppStateError.unavailable }
                        try state.applyChanges(page)
                        try commit(state)
                        current = page.cursor
                        if !page.hasMore { return }
                    }
                    throw APIError.invalidResponse
                } else {
                    var pages: [D1BootstrapPage] = []
                    var cursor: String?
                    var seen = Set<String>()
                    for _ in 0..<10_000 {
                        let page = try await api.bootstrap(session: saved, cursor: cursor)
                        pages.append(page)
                        if page.complete {
                            guard var state = d1 else { throw AppStateError.unavailable }
                            try state.publishBootstrap(pages: pages)
                            try commit(state)
                            return
                        }
                        guard let next = page.nextCursor, seen.insert(next).inserted else { throw APIError.invalidResponse }
                        cursor = next
                    }
                    throw APIError.invalidResponse
                }
            } catch APIError.bootstrapRequired {
                guard var state = d1 else { throw AppStateError.unavailable }
                state.invalidateAuthorization()
                // Hide immediately even if writing the invalidation fails.
                workspace = nil; d1 = state
                try commit(state)
            }
        }
        throw APIError.bootstrapRequired
    }

    private func commit(_ state: D1Workspace) throws {
        guard let store, state.account.id == session?.account.id else { throw AppStateError.unavailable }
        let presentation = try state.presentationWorkspace()
        try store.saveD1(state, accountID: state.account.id)
        d1 = state
        workspace = state.cursor == nil && state.entities.isEmpty ? nil : presentation
    }

    private func endExpiredSession() {
        workspace = nil; d1 = nil; session = nil
        do { try keychain.clear(); message = "Please sign in again. Your saved drafts are retained for the same account." }
        catch { message = "Sign-in ended, but the saved credential could not be removed: \(error.localizedDescription)" }
    }

    func signOut() async {
        guard !isBusy else { return }
        let previous = session
        do { try keychain.clear() }
        catch { message = "Could not remove the saved sign-in: \(error.localizedDescription)"; return }
        workspace = nil; d1 = nil; session = nil; isDemo = false; message = nil
        if let previous {
            isBusy = true
            defer { isBusy = false }
            do { try await api.logout(session: previous) }
            catch { message = "Signed out on this device. The server could not be reached." }
        }
    }

    func save(record: ItineraryRecord, expectedRevision: Int? = nil) throws {
        try checkEditor(tripID: record.tripID, expectedRevision: expectedRevision)
        if isDemo {
            guard var local = workspace, let store else { throw AppStateError.unavailable }
            try local.stage(record); try store.save(local); workspace = local
        } else {
            guard var state = d1 else { throw AppStateError.unavailable }
            try state.stage(record); try commit(state)
        }
    }

    func delete(record: ItineraryRecord, expectedRevision: Int? = nil) throws {
        try checkEditor(tripID: record.tripID, expectedRevision: expectedRevision)
        if isDemo {
            guard var local = workspace, let store else { throw AppStateError.unavailable }
            try local.remove(record); try store.save(local); workspace = local
        } else {
            guard var state = d1 else { throw AppStateError.unavailable }
            try state.remove(record); try commit(state)
        }
    }

    private func checkEditor(tripID: String, expectedRevision: Int?) throws {
        guard !isBusy, workspace != nil else { throw AppStateError.unavailable }
        if let expectedRevision, trip(id: tripID)?.revision != expectedRevision { throw AppStateError.staleEditor }
    }

    func createTrip(name: String, startDate: String, endDate: String) throws {
        guard !isBusy else { throw AppStateError.unavailable }
        if isDemo {
            guard var local = workspace, let store else { throw AppStateError.unavailable }
            var validator = D1Workspace(account: local.account)
            let id = try validator.createTrip(name: name, startDate: startDate, endDate: endDate)
            local.trips.append(TripSnapshot(id: id, name: name, startDate: startDate, endDate: endDate, role: .superuser))
            try store.save(local); workspace = local
        } else {
            guard var state = d1, state.cursor != nil else { throw AppStateError.unavailable }
            try state.createTrip(name: name, startDate: startDate, endDate: endDate); try commit(state)
        }
    }

    func discardDraft(id: UUID) throws {
        guard !isBusy else { throw AppStateError.unavailable }
        if isDemo {
            guard var local = workspace, let store else { throw AppStateError.unavailable }
            // Demo has no server base; its pending changes are kept as local plans.
            local.mutations.removeAll { $0.id == id }; try store.save(local); workspace = local
        } else {
            guard var state = d1 else { throw AppStateError.unavailable }
            try state.discard(id: id); try commit(state)
        }
    }

    func reapplyDraft(id: UUID) throws {
        guard !isBusy, !isDemo, var state = d1 else { throw AppStateError.unavailable }
        try state.reapply(id: id); try commit(state)
    }

    func isDraftSubmitted(id: UUID) -> Bool { d1?.outbox.contains { $0.id == id && $0.status == .submitted } ?? false }

    /// Expose a retained draft for review only after current server permissions
    /// permit this specific operation. Quarantine itself never grants access.
    func localRecord(for mutation: PendingMutation) -> ItineraryRecord? {
        if isDemo { return mutation.record }
        guard let state = d1, state.cursor != nil,
              var entry = state.outbox.first(where: { $0.id == mutation.id }),
              let trip = state.entities.first(where: { $0.kind == .trip && $0.tripId == mutation.tripID && $0.operation == .upsert }),
              let permission = trip.permission else { return nil }
        if permission.role == .user {
            guard entry.mutation.operation == .update,
                  let remote = state.entities.first(where: { $0.key == entry.mutation.key && $0.operation == .upsert }),
                  case .array(let tags)? = remote.data?["companions"], tags.contains(.string(permission.companionId)),
                  entry.mutation.data?["companions"] == nil || entry.mutation.data?["companions"] == remote.data?["companions"] else { return nil }
        } else if permission.role != .superuser && permission.role != .admin { return nil }
        if entry.mutation.operation == .delete { return serverRecord(for: mutation) }
        entry.status = .queued; entry.isQuarantined = nil
        let projection = D1Workspace(account: state.account, entities: state.entities, outbox: [entry], cursor: state.cursor)
        return (try? projection.presentationTrips())?.first { $0.id == mutation.tripID }?.records.first {
            $0.id == mutation.recordID && $0.kind == mutation.kind
        }
    }

    func serverRecord(for mutation: PendingMutation) -> ItineraryRecord? {
        guard let state = d1 else { return nil }
        let base = D1Workspace(account: state.account, entities: state.entities, cursor: state.cursor)
        return (try? base.presentationTrips())?.first { $0.id == mutation.tripID }?.records.first {
            $0.id == mutation.recordID && $0.kind == mutation.kind
        }
    }

    func trip(id: String) -> TripSnapshot? { trips.first { $0.id == id } }
}

private enum AppStateError: LocalizedError {
    case unavailable, staleEditor
    var errorDescription: String? {
        switch self {
        case .unavailable: return "Offline storage is unavailable or a sync is in progress. Your input has not been saved."
        case .staleEditor: return "This trip changed while the editor was open. Your input is still here. Reopen the latest item before saving."
        }
    }
}
