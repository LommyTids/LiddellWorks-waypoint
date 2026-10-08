import SwiftUI
import UIKit
import WayPointCore

enum WayPointStyle {
    // Shared Atlas semantic palette; native type scales with Dynamic Type.
    static let canvas = adaptive(0xedf3f6, dark: 0x0f1d2b)
    static let surface = adaptive(0xffffff, dark: 0x172b3b)
    static let subdued = adaptive(0xe9f1f5, dark: 0x243b4a)
    static let navy = adaptive(0x17374c, dark: 0xedf6fa)
    static let muted = adaptive(0x4a6474, dark: 0xb3c9d5)
    static let line = adaptive(0xb8cbd5, dark: 0x4b6779)
    static let teal = adaptive(0x006b7e, dark: 0x72d9dc)
    static let tealSoft = adaptive(0xdef2f3, dark: 0x164651)
    static let amber = adaptive(0x995900, dark: 0xf1bd78)
    static let amberSoft = adaptive(0xfff3df, dark: 0x3b3025)
    static let danger = adaptive(0x9c3039, dark: 0xf2a6b0)
    static let brandBlue = Color(red: 23 / 255, green: 55 / 255, blue: 76 / 255)

    private static func adaptive(_ light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((hex >> 16) & 255) / 255,
                           green: CGFloat((hex >> 8) & 255) / 255,
                           blue: CGFloat(hex & 255) / 255, alpha: 1)
        })
    }

    static func color(for kind: RecordKind) -> Color {
        switch kind {
        case .destination: return teal
        case .transport: return adaptive(0x1765b3, dark: 0x63adff)
        case .accommodation: return adaptive(0xa93968, dark: 0xff6aa0)
        case .activity: return adaptive(0xb75700, dark: 0xffad5c)
        }
    }
}

struct AtlasCard: ViewModifier {
    var cornerRadius: CGFloat = 20
    func body(content: Content) -> some View {
        content
            .background(WayPointStyle.surface, in: RoundedRectangle(cornerRadius: cornerRadius))
            .overlay(RoundedRectangle(cornerRadius: cornerRadius).stroke(WayPointStyle.line, lineWidth: 1))
    }
}

enum WayPointType {
    static let display = Font.custom("Fraunces-SemiBold", size: 28, relativeTo: .title2)
    static let heading = Font.custom("Fraunces-SemiBold", size: 20, relativeTo: .title3)
    static let body = Font.custom("WorkSans-Regular", size: 15, relativeTo: .body)
    static let label = Font.custom("WorkSansRoman-SemiBold", size: 14, relativeTo: .subheadline)
    static let meta = Font.custom("IBMPlexMono-Medium", size: 12, relativeTo: .caption)
    static let micro = Font.custom("WorkSans-Regular", size: 11, relativeTo: .caption2)
}

private struct AtlasGlass: ViewModifier {
    var cornerRadius: CGFloat
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    @ViewBuilder
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if reduceTransparency {
            content.background(WayPointStyle.surface, in: shape)
                .overlay(shape.stroke(WayPointStyle.line, lineWidth: 1))
        } else {
            #if compiler(>=6.2)
            if #available(iOS 26.0, *) {
                content.glassEffect(.regular, in: shape)
            } else {
                content.background(.regularMaterial, in: shape)
                    .overlay(shape.stroke(WayPointStyle.line.opacity(0.6), lineWidth: 0.5))
            }
            #else
            // Older Xcode SDKs can compile the supported material fallback.
            content.background(.regularMaterial, in: shape)
                .overlay(shape.stroke(WayPointStyle.line.opacity(0.6), lineWidth: 0.5))
            #endif
        }
    }
}

extension View {
    func atlasCard(cornerRadius: CGFloat = 20) -> some View { modifier(AtlasCard(cornerRadius: cornerRadius)) }
    func atlasGlass(cornerRadius: CGFloat = 30) -> some View { modifier(AtlasGlass(cornerRadius: cornerRadius)) }
    func atlasForm() -> some View {
        scrollContentBackground(.hidden)
            .background(WayPointStyle.canvas)
    }
}

struct AtlasButtonStyle: ButtonStyle {
    enum Role { case primary, selection, amendment, neutral }
    var role: Role = .primary
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let foreground = role == .primary ? Color.white : role == .amendment ? WayPointStyle.amber : role == .neutral ? WayPointStyle.muted : WayPointStyle.teal
        let background = role == .primary ? WayPointStyle.brandBlue : role == .amendment ? WayPointStyle.amberSoft : role == .neutral ? WayPointStyle.surface : WayPointStyle.tealSoft
        configuration.label
            .font(.custom("WorkSansRoman-SemiBold", size: 17, relativeTo: .body))
            .foregroundStyle(foreground)
            .padding(.horizontal, 16)
            .frame(minHeight: 48)
            .background(background, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(role == .primary ? background : role == .neutral ? WayPointStyle.line : foreground, lineWidth: 1))
            .opacity(isEnabled ? (configuration.isPressed ? 0.75 : 1) : 0.45)
    }
}

struct WayPointBrand: View {
    var compact = false
    var body: some View {
        HStack(spacing: compact ? 6 : 10) {
            WayPointMark(width: compact ? 28 : 44)
            Text("WayPoint")
                .font(.custom("Fraunces-SemiBold", size: compact ? 18 : 22, relativeTo: .title3))
                .foregroundStyle(WayPointStyle.navy)
        }
    }
}

struct WayPointMark: View {
    var width: CGFloat = 30
    var body: some View {
        Image("WayPointMark").resizable().scaledToFit()
            .frame(width: width, height: width * 0.75)
            .padding(2)
            .background(WayPointStyle.brandBlue, in: RoundedRectangle(cornerRadius: 7))
            .accessibilityHidden(true)
    }
}

struct ParticipantNames: View {
    let trip: TripSnapshot
    let ids: [String]

    var body: some View {
        Label(ids.isEmpty ? "No people assigned" : ids.map { TripParticipant.name(for: $0, in: trip) }.joined(separator: ", "),
              systemImage: ids.isEmpty ? "person.crop.circle.badge.questionmark" : "person.2")
            .font(.caption.weight(.medium))
            .foregroundStyle(WayPointStyle.muted)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct TripParticipant: Identifiable {
    let id: String
    let name: String

    static func all(in trip: TripSnapshot) -> [TripParticipant] {
        var result = [TripParticipant(id: "__trip_superuser__", name: "Trip owner")]
        if case .array(let values)? = trip.raw["companions"] {
            for value in values {
                let id = identifier(value["companionId"])
                guard !id.isEmpty, !result.contains(where: { $0.id == id }) else { continue }
                let name = text(value["name"])
                result.append(TripParticipant(id: id, name: name.isEmpty ? "Unnamed traveller" : name))
            }
        }
        return result
    }

    static func name(for id: String, in trip: TripSnapshot) -> String {
        all(in: trip).first(where: { $0.id == id })?.name ?? "Unavailable traveller"
    }

    static func canEdit(_ record: ItineraryRecord, in trip: TripSnapshot) -> Bool {
        if trip.role.allowsAddingAndDeleting { return true }
        guard trip.role == .user,
              let current = trip.records.first(where: { $0.kind == record.kind && $0.id == record.id }) else { return false }
        let companionID = identifier(trip.raw["myGrant"]?["companionId"])
        return !companionID.isEmpty && current.companions.contains(companionID)
    }

    static func text(_ value: JSONValue?) -> String {
        if case .string(let text)? = value { return text }
        return ""
    }

    static func identifier(_ value: JSONValue?) -> String {
        switch value {
        case .string(let value): return value
        case .number(let value) where value.isFinite && value.rounded() == value && abs(value) <= 9_007_199_254_740_991:
            return String(Int64(value))
        default: return ""
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
            .foregroundStyle(WayPointStyle.amber)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(WayPointStyle.amberSoft, in: Capsule())
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
        .foregroundStyle(WayPointStyle.muted)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(WayPointStyle.subdued, in: RoundedRectangle(cornerRadius: 12))
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
