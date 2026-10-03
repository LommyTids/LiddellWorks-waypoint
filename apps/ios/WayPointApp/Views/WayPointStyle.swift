import SwiftUI
import WayPointCore

enum WayPointStyle {
    static let teal = Color(red: 0.05, green: 0.48, blue: 0.48)
    static let navy = Color(red: 0.10, green: 0.20, blue: 0.29)

    static func color(for kind: RecordKind) -> Color {
        switch kind {
        case .destination: return teal
        case .transport: return .blue
        case .accommodation: return .purple
        case .activity: return .orange
        }
    }
}

enum LocalTripDate {
    // GMT is only a stable carrier for civil components, never a claim about
    // the itinerary timezone. It avoids the phone's DST gaps shifting a plan.
    static let carrierZone = TimeZone(secondsFromGMT: 0)!
    static func parse(_ value: String) -> Date? {
        for format in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd"] {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.timeZone = carrierZone
            formatter.dateFormat = format
            formatter.isLenient = false
            if let date = formatter.date(from: value) { return date }
        }
        return nil
    }

    static func encode(_ date: Date, allDay: Bool) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = carrierZone
        formatter.dateFormat = allDay ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm"
        return formatter.string(from: date)
    }

    static func day(_ value: String) -> String {
        guard let date = parse(String(value.prefix(10))) else {
            return value.isEmpty ? "Date to be planned" : String(value.prefix(10))
        }
        let formatter = DateFormatter()
        formatter.timeZone = carrierZone
        formatter.setLocalizedDateFormatFromTemplate("dMMMyyyy")
        return formatter.string(from: date)
    }

    static func time(_ value: String) -> String? {
        guard value.count > 10, let date = parse(value) else { return nil }
        let formatter = DateFormatter()
        formatter.timeZone = carrierZone
        formatter.setLocalizedDateFormatFromTemplate("jmm")
        return formatter.string(from: date)
    }

    static func range(start: String, end: String) -> String {
        if start.isEmpty { return "Dates to be planned" }
        if end.isEmpty || start.prefix(10) == end.prefix(10) { return day(start) }
        return "\(day(start)) – \(day(end))"
    }
}

struct LocalDraftBadge: View {
    var body: some View {
        Label("Pending change", systemImage: "pencil.circle.fill")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.orange)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(.orange.opacity(0.12), in: Capsule())
    }
}

struct DraftNotice: View {
    let isDemo: Bool
    var body: some View {
        Label {
            Text(isDemo
                 ? "Demo trip. Changes stay on this device."
                 : "Save offline, then tap Sync now to send changes to your WayPoint account.")
                .font(.footnote)
        } icon: {
            Image(systemName: "internaldrive")
        }
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct RecordKindIcon: View {
    let kind: RecordKind
    var body: some View {
        Image(systemName: kind.symbol)
            .font(.headline)
            .foregroundStyle(WayPointStyle.color(for: kind))
            .frame(width: 42, height: 42)
            .background(WayPointStyle.color(for: kind).opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
            .accessibilityHidden(true)
    }
}

extension TripRole {
    var allowsAddingAndDeleting: Bool { self == .admin || self == .superuser }
    var displayTitle: String {
        switch self {
        case .superuser: return "Owner"
        case .admin: return "Trip editor"
        case .user: return "Contributor"
        case .viewer: return "Read only"
        }
    }
}
