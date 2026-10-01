import Foundation

public enum LocalWorkspaceError: Error, LocalizedError, Equatable {
    case accountMismatch
    case tripUnavailable
    case readOnly
    case scopedPermission
    case invalidRecord(String)
    case invalidSnapshot

    public var errorDescription: String? {
        switch self {
        case .accountMismatch: return "These drafts belong to a different account. Sign in to the original account to use them."
        case .tripUnavailable: return "This trip is no longer available. Refresh your trips before editing."
        case .readOnly: return "You have read-only access to this trip."
        case .scopedPermission: return "Your trip access allows editing existing items tagged to you. It does not allow adding, deleting or changing participants."
        case .invalidRecord(let message): return message
        case .invalidSnapshot: return "The refreshed trip data is inconsistent. Your saved copy has not been replaced."
        }
    }
}

/// Durable, account-bound local edits. Nothing here sends a network request.
/// Persist the entire value after each successful mutation (see WorkspaceStore).
public struct LocalWorkspace: Codable, Equatable, Sendable {
    public var account: Account
    public var trips: [TripSnapshot]
    public var mutations: [PendingMutation]
    public var lastRefresh: Date?

    public init(account: Account, trips: [TripSnapshot] = [],
                mutations: [PendingMutation] = [], lastRefresh: Date? = nil) {
        self.account = account; self.trips = trips
        self.mutations = mutations; self.lastRefresh = lastRefresh
    }

    public mutating func stage(_ record: ItineraryRecord) throws {
        try checkAccount()
        guard let tripIndex = trips.firstIndex(where: { $0.id == record.tripID }) else {
            throw LocalWorkspaceError.tripUnavailable
        }
        let trip = trips[tripIndex]
        guard trip.role.canEdit else { throw LocalWorkspaceError.readOnly }
        try Self.validate(record)
        let oldRecord = trip.records.first { $0.id == record.id && $0.kind == record.kind }
        if trip.role == .user {
            guard let oldRecord, let companionID = trip.raw["myGrant"]?["companionId"]?.identifier,
                  oldRecord.companions.contains(companionID), record.companions == oldRecord.companions else {
                throw LocalWorkspaceError.scopedPermission
            }
        }
        var updated = record
        // The editor cannot accidentally discard unsupported booking, cost or geo fields.
        if let oldRecord { updated.raw = oldRecord.raw }
        if let index = trips[tripIndex].records.firstIndex(where: { $0.id == updated.id && $0.kind == updated.kind }) {
            trips[tripIndex].records[index] = updated
        } else { trips[tripIndex].records.append(updated) }
        coalesce(record: updated, operation: .upsert, trip: trip)
    }

    public mutating func remove(_ record: ItineraryRecord) throws {
        try checkAccount()
        guard let tripIndex = trips.firstIndex(where: { $0.id == record.tripID }) else {
            throw LocalWorkspaceError.tripUnavailable
        }
        let trip = trips[tripIndex]
        guard trip.role.canEdit else { throw LocalWorkspaceError.readOnly }
        guard trip.role != .user else { throw LocalWorkspaceError.scopedPermission }
        guard trip.records.contains(where: { $0.id == record.id && $0.kind == record.kind }) else {
            throw LocalWorkspaceError.invalidRecord("This item no longer exists in your local trip.")
        }
        trips[tripIndex].records.removeAll { $0.id == record.id && $0.kind == record.kind }
        coalesce(record: record, operation: .delete, trip: trip)
    }

    /// Call only with a complete, successfully decoded server response. An empty
    /// successful response revokes all trips; a failed fetch must never call this.
    public mutating func refresh(with incoming: [TripSnapshot], at date: Date = Date()) throws {
        try checkAccount()
        try Self.validateSnapshots(incoming)
        var refreshed = incoming
        var retained: [PendingMutation] = []
        for var mutation in mutations {
            guard let tripIndex = refreshed.firstIndex(where: { $0.id == mutation.tripID }) else {
                continue // Revoke both the trip cache and every related draft.
            }
            let trip = refreshed[tripIndex]
            let serverRecord = incoming[tripIndex].records.first {
                $0.id == mutation.recordID && $0.kind == mutation.kind
            }
            // If this identity now exists remotely, a later local deletion must
            // not be mistaken for cancelling an unsaved creation.
            if serverRecord != nil { mutation.isLocalCreation = false }
            if trip.role == .viewer || trip.role == .user {
                // A narrowed grant must not reintroduce a now-hidden record.
                guard let serverRecord else { continue }
                if trip.role == .viewer {
                    mutation.status = .blocked
                    mutation.message = "Editing permission was removed. This draft is not applied."
                } else if mutation.operation == .delete ||
                            !Self.canApplyScoped(mutation, to: serverRecord, trip: trip) {
                    mutation.status = .blocked
                    mutation.message = "Your current permission does not allow this change. This draft is not applied."
                } else {
                    Self.updateRevisionStatus(&mutation, revision: trip.revision)
                }
            } else {
                Self.updateRevisionStatus(&mutation, revision: trip.revision)
            }
            retained.append(mutation)
            guard mutation.status != .blocked else { continue }
            // Conflicts keep local work visible but are explicitly marked. The
            // server version remains in trip.raw; no conflict is auto-resolved.
            switch mutation.operation {
            case .upsert:
                guard let record = mutation.record else { throw LocalWorkspaceError.invalidSnapshot }
                if let recordIndex = refreshed[tripIndex].records.firstIndex(where: {
                    $0.id == mutation.recordID && $0.kind == mutation.kind
                }) {
                    refreshed[tripIndex].records[recordIndex] = record
                } else { refreshed[tripIndex].records.append(record) }
            case .delete:
                refreshed[tripIndex].records.removeAll { $0.id == mutation.recordID && $0.kind == mutation.kind }
            }
        }
        // Commit the complete refresh atomically only after all checks succeeded.
        trips = refreshed; mutations = retained; lastRefresh = date
    }

    private mutating func coalesce(record: ItineraryRecord, operation: MutationOperation, trip: TripSnapshot) {
        if let index = mutations.firstIndex(where: {
            $0.accountID == account.id && $0.tripID == trip.id && $0.recordID == record.id && $0.kind == record.kind
        }) {
            if operation == .delete && mutations[index].isLocalCreation == true {
                mutations.remove(at: index)
                return
            }
            // Preserve the original revision and timestamp: subsequent local
            // editing must never silently rebase an unresolved server conflict.
            mutations[index].operation = operation
            mutations[index].record = operation == .upsert ? record : nil
        } else {
            mutations.append(PendingMutation(accountID: account.id, tripID: trip.id,
                                             recordID: record.id, kind: record.kind,
                                             operation: operation, baseRevision: trip.revision,
                                             record: operation == .upsert ? record : nil,
                                             isLocalCreation: operation == .upsert && !trip.records.contains {
                                                 $0.id == record.id && $0.kind == record.kind
                                             }))
        }
    }

    private func checkAccount() throws {
        guard !account.id.isEmpty, mutations.allSatisfy({ $0.accountID == account.id }) else {
            throw LocalWorkspaceError.accountMismatch
        }
        var identities = Set<String>()
        for mutation in mutations {
            let identity = mutation.tripID + ":" + mutation.kind.rawValue + ":" + mutation.recordID
            guard identities.insert(identity).inserted else { throw LocalWorkspaceError.invalidSnapshot }
            if mutation.operation == .upsert {
                guard let record = mutation.record, record.id == mutation.recordID,
                      record.tripID == mutation.tripID, record.kind == mutation.kind else {
                    throw LocalWorkspaceError.invalidSnapshot
                }
            }
        }
    }

    private static func canApplyScoped(_ mutation: PendingMutation, to record: ItineraryRecord,
                                       trip: TripSnapshot) -> Bool {
        guard let companionID = trip.raw["myGrant"]?["companionId"]?.identifier,
              let draft = mutation.record else { return false }
        return record.companions.contains(companionID) && draft.companions == record.companions
    }

    private static func updateRevisionStatus(_ mutation: inout PendingMutation, revision: Int) {
        // Never auto-resolve a conflict just because an eventually consistent
        // read happens to return the original revision again.
        if mutation.status == .conflict || mutation.baseRevision != revision {
            mutation.status = .conflict
            mutation.message = "This trip changed on the web after your local edit. Review both versions before future sync."
        } else {
            mutation.status = .queued
            mutation.message = nil
        }
    }

    private static func validateSnapshots(_ trips: [TripSnapshot]) throws {
        var tripIDs = Set<String>()
        for trip in trips {
            guard !trip.id.isEmpty, trip.revision >= 0, tripIDs.insert(trip.id).inserted else {
                throw LocalWorkspaceError.invalidSnapshot
            }
            var recordIDs = Set<String>()
            for record in trip.records {
                guard record.tripID == trip.id, !record.id.isEmpty,
                      recordIDs.insert(record.kind.rawValue + ":" + record.id).inserted else {
                    throw LocalWorkspaceError.invalidSnapshot
                }
            }
        }
    }

    private static func validate(_ record: ItineraryRecord) throws {
        guard JSONValue.string(record.id).identifier != nil,
              JSONValue.string(record.tripID).identifier != nil else {
            throw LocalWorkspaceError.invalidRecord("This item has an invalid identifier.")
        }
        guard !record.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw LocalWorkspaceError.invalidRecord("Enter a title for this item.")
        }
        for value in [record.start, record.end] where !value.isEmpty {
            guard validWallClock(value) else {
                throw LocalWorkspaceError.invalidRecord("Use a valid date (YYYY-MM-DD) or local date and time (YYYY-MM-DDTHH:mm).")
            }
        }
        // Transport crosses timezones; comparing departure and arrival wall
        // clocks can falsely reject a valid journey, so defer that comparison.
        if record.kind != .transport, !record.start.isEmpty, !record.end.isEmpty {
            let startDay = String(record.start.prefix(10)), endDay = String(record.end.prefix(10))
            if endDay < startDay || (record.start.count == record.end.count && record.end < record.start) {
                throw LocalWorkspaceError.invalidRecord("The end must not be before the start.")
            }
        }
        if record.place.latitude != nil || record.place.longitude != nil {
            guard record.place.hasCoordinate else {
                throw LocalWorkspaceError.invalidRecord("Enter both latitude (−90 to 90) and longitude (−180 to 180).")
            }
        }
        if let zone = record.timeZoneID, !zone.isEmpty, TimeZone(identifier: zone) == nil {
            throw LocalWorkspaceError.invalidRecord("Choose a valid timezone, such as Europe/London.")
        }
    }

    private static func validWallClock(_ value: String) -> Bool {
        guard value.range(of: "^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2})?$", options: .regularExpression) != nil else { return false }
        let parts = value.split(whereSeparator: { "-T:".contains($0) }).compactMap { Int($0) }
        guard parts.count == 3 || parts.count == 5, parts[0] > 0 else { return false }
        let hour = parts.count == 5 ? parts[3] : 0
        let minute = parts.count == 5 ? parts[4] : 0
        guard (0...23).contains(hour), (0...59).contains(minute) else { return false }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let components = DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: hour, minute: minute)
        guard let date = calendar.date(from: components) else { return false }
        let roundTrip = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        return roundTrip.year == parts[0] && roundTrip.month == parts[1] && roundTrip.day == parts[2]
            && roundTrip.hour == hour && roundTrip.minute == minute
    }
}
