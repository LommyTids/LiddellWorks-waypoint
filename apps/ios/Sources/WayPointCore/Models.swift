import Foundation

/// Lossless for the legacy API's JSON structure and supported number range.
/// Original server objects are kept alongside the app's narrower editing model.
public enum JSONValue: Codable, Equatable, Sendable {
    case object([String: JSONValue])
    case array([JSONValue])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    public subscript(_ key: String) -> JSONValue? {
        guard case .object(let values) = self else { return nil }
        return values[key]
    }

    var object: [String: JSONValue]? {
        guard case .object(let value) = self else { return nil }
        return value
    }

    var text: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }

    var coordinate: Double? {
        let result: Double?
        switch self {
        case .number(let value): result = value
        case .string(let value): result = Double(value)
        default: result = nil
        }
        guard let result, result.isFinite else { return nil }
        return result
    }

    var truthy: Bool {
        switch self {
        case .bool(let value): return value
        case .string(let value): return value == "true" || value == "on"
        default: return false
        }
    }

    /// The Worker uses safe string identifiers. Avoid silently rounding numeric IDs.
    var identifier: String? {
        let value: String
        switch self {
        case .string(let string): value = string
        case .number(let number):
            guard number.isFinite, number.rounded() == number,
                  abs(number) <= 9_007_199_254_740_991 else { return nil }
            value = String(Int64(number))
        default: return nil
        }
        guard value.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil else { return nil }
        return value
    }
}

public enum RecordKind: String, CaseIterable, Codable, Identifiable, Sendable {
    case destination, transport, accommodation, activity
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .destination: return "Destination"
        case .transport: return "Transport"
        case .accommodation: return "Accommodation"
        case .activity: return "Activity"
        }
    }
    public var symbol: String {
        switch self {
        case .destination: return "mappin.and.ellipse"
        case .transport: return "airplane"
        case .accommodation: return "bed.double"
        case .activity: return "ticket"
        }
    }
    var legacyList: String {
        switch self {
        case .destination: return "destinations"
        case .transport: return "transport"
        case .accommodation: return "accommodation"
        case .activity: return "activities"
        }
    }
    var legacyID: String { rawValue + "Id" }
}

public enum TripRole: String, Codable, Sendable {
    case superuser, admin, user, viewer
    public var canEdit: Bool { self != .viewer }
}

public struct Place: Codable, Equatable, Sendable {
    public var venue: String
    public var address: String
    public var latitude: Double?
    public var longitude: Double?

    public init(venue: String = "", address: String = "", latitude: Double? = nil, longitude: Double? = nil) {
        self.venue = venue; self.address = address
        self.latitude = latitude; self.longitude = longitude
    }

    public var hasCoordinate: Bool {
        guard let latitude, let longitude else { return false }
        return latitude.isFinite && longitude.isFinite
            && (-90...90).contains(latitude) && (-180...180).contains(longitude)
    }
}

public struct ItineraryRecord: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var tripID: String
    public var kind: RecordKind
    public var title: String
    /// Local wall-clock strings: YYYY-MM-DD or YYYY-MM-DDTHH:mm, never implicit UTC.
    public var start: String
    public var end: String
    public var allDay: Bool
    public var timeZoneID: String?
    public var place: Place
    public var notes: String
    public var companions: [String]
    /// Original server record; normalized local changes live in the properties above.
    public var raw: JSONValue

    public init(id: String, tripID: String, kind: RecordKind, title: String,
                start: String = "", end: String = "", allDay: Bool = false,
                timeZoneID: String? = nil, place: Place = Place(), notes: String = "",
                companions: [String] = [], raw: JSONValue = .object([:])) {
        self.id = id; self.tripID = tripID; self.kind = kind; self.title = title
        self.start = start; self.end = end; self.allDay = allDay
        self.timeZoneID = timeZoneID; self.place = place; self.notes = notes
        self.companions = companions; self.raw = raw
    }
}

public struct TripSnapshot: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var startDate: String
    public var endDate: String
    public var notes: String
    public var revision: Int
    public var role: TripRole
    public var records: [ItineraryRecord]
    /// Complete visible server trip, including fields this app does not yet expose.
    public var raw: JSONValue

    public init(id: String, name: String, startDate: String = "", endDate: String = "",
                notes: String = "", revision: Int = 0, role: TripRole = .viewer,
                records: [ItineraryRecord] = [], raw: JSONValue = .object([:])) {
        self.id = id; self.name = name; self.startDate = startDate; self.endDate = endDate
        self.notes = notes; self.revision = revision; self.role = role
        self.records = records; self.raw = raw
    }
}

public struct Account: Codable, Equatable, Sendable {
    public var id: String
    public var username: String
    public init(id: String, username: String) { self.id = id; self.username = username }
}

public enum MutationOperation: String, Codable, Sendable { case upsert, delete }
public enum MutationStatus: String, Codable, Sendable { case queued, conflict, blocked }

public struct PendingMutation: Codable, Equatable, Identifiable, Sendable {
    public var id: UUID
    public var accountID: String
    public var tripID: String
    public var recordID: String
    public var kind: RecordKind
    public var operation: MutationOperation
    public var baseRevision: Int
    public var record: ItineraryRecord?
    public var createdAt: Date
    public var status: MutationStatus
    public var message: String?
    /// Optional for compatibility with earlier caches. Only an explicit `true`
    /// proves this record was created locally and can be cancelled on deletion.
    public var isLocalCreation: Bool?

    public init(id: UUID = UUID(), accountID: String, tripID: String, recordID: String,
                kind: RecordKind, operation: MutationOperation, baseRevision: Int,
                record: ItineraryRecord? = nil, createdAt: Date = Date(),
                status: MutationStatus = .queued, message: String? = nil,
                isLocalCreation: Bool? = nil) {
        self.id = id; self.accountID = accountID; self.tripID = tripID; self.recordID = recordID
        self.kind = kind; self.operation = operation; self.baseRevision = baseRevision
        self.record = record; self.createdAt = createdAt; self.status = status; self.message = message
        self.isLocalCreation = isLocalCreation
    }
}
