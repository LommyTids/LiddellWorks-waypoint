import SwiftUI
import MapKit
import WayPointCore

struct TripDetailView: View {
    @EnvironmentObject private var model: AppModel
    let tripID: String
    @State private var selectedPage: TripPage = .timeline
    @State private var editor: EditorRequest?

    var body: some View {
        Group {
            if let trip = model.trip(id: tripID) {
                VStack(spacing: 0) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(LocalTripDate.range(start: trip.startDate, end: trip.endDate))
                            .font(.subheadline).foregroundStyle(.secondary)
                        if !trip.role.canEdit {
                            Label("Read-only trip", systemImage: "eye")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        Picker("Trip view", selection: $selectedPage) {
                            ForEach(TripPage.allCases) { page in Text(page.rawValue).tag(page) }
                        }
                        .pickerStyle(.segmented)
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 14)
                    switch selectedPage {
                    case .timeline: itinerary(trip, groupedByKind: false)
                    case .map: TripMapView(records: trip.records) {
                        guard !model.isBusy else { return }
                        editor = EditorRequest(existing: $0, revision: trip.revision)
                    }
                    case .plan: itinerary(trip, groupedByKind: true)
                    }
                }
                .navigationTitle(trip.name)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if trip.role.allowsAddingAndDeleting {
                        ToolbarItem(placement: .topBarTrailing) {
                            Menu {
                                ForEach(RecordKind.allCases) { kind in
                                    Button { editor = EditorRequest(kind: kind, revision: trip.revision) } label: {
                                        Label(kind.title, systemImage: kind.symbol)
                                    }
                                }
                            } label: {
                                Label("Add itinerary item", systemImage: "plus")
                            }
                            .disabled(model.isBusy)
                        }
                    }
                }
            } else {
                ContentUnavailableView("Trip unavailable", systemImage: "suitcase", description: Text("It may have been removed or your access may have changed. Return to your trips and refresh."))
            }
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .sheet(item: $editor) { request in
            NavigationStack {
                RecordEditorView(tripID: tripID, kind: request.kind, existing: request.existing, expectedRevision: request.revision)
            }
        }
    }

    private func itinerary(_ trip: TripSnapshot, groupedByKind: Bool) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                DraftNotice(isDemo: model.isDemo)
                if !trip.notes.isEmpty && groupedByKind {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Trip notes").font(.headline)
                        Text(trip.notes).font(.subheadline).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
                }
                if trip.records.isEmpty {
                    ContentUnavailableView("A trip waiting to happen", systemImage: "point.topleft.down.curvedto.point.bottomright.up", description: Text(trip.role.allowsAddingAndDeleting ? "Add a destination, journey, stay, or activity using the plus button." : "There are no itinerary items to display yet."))
                } else if groupedByKind {
                    ForEach(RecordKind.allCases) { kind in
                        let records = sorted(trip.records.filter { $0.kind == kind })
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Label(kind.title, systemImage: kind.symbol).font(.headline)
                                Spacer()
                                Text("\(records.count)").font(.subheadline).foregroundStyle(.secondary)
                            }
                            if records.isEmpty {
                                Text("Nothing planned yet").font(.subheadline).foregroundStyle(.secondary)
                                    .padding(.vertical, 10)
                            } else {
                                ForEach(records) { record in recordButton(record) }
                            }
                        }
                    }
                } else {
                    ForEach(dayKeys(trip.records), id: \.self) { day in
                        VStack(alignment: .leading, spacing: 10) {
                            Text(day.isEmpty ? "Date to be planned" : LocalTripDate.day(day))
                                .font(.headline)
                            ForEach(sorted(trip.records.filter { String($0.start.prefix(10)) == day }), id: \.viewIdentity) { record in
                                recordButton(record)
                            }
                        }
                    }
                }
            }
            .padding(20)
            .frame(maxWidth: 860)
            .frame(maxWidth: .infinity)
        }
    }

    private func recordButton(_ record: ItineraryRecord) -> some View {
        Button {
            guard let trip = model.trip(id: tripID), !model.isBusy else { return }
            editor = EditorRequest(existing: record, revision: trip.revision)
        } label: {
            ItineraryRow(record: record, isDraft: model.workspace?.mutations.contains { $0.tripID == tripID && $0.recordID == record.id && $0.kind == record.kind } ?? false)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Open itinerary details")
    }

    private func sorted(_ records: [ItineraryRecord]) -> [ItineraryRecord] {
        records.sorted {
            if $0.start == $1.start { return $0.title.localizedStandardCompare($1.title) == .orderedAscending }
            if $0.start.isEmpty { return false }
            if $1.start.isEmpty { return true }
            return $0.start < $1.start
        }
    }

    private func dayKeys(_ records: [ItineraryRecord]) -> [String] {
        Set(records.map { String($0.start.prefix(10)) }).sorted { lhs, rhs in
            if lhs.isEmpty { return false }
            if rhs.isEmpty { return true }
            return lhs < rhs
        }
    }
}

private enum TripPage: String, CaseIterable, Identifiable {
    case timeline = "Timeline", map = "Map", plan = "Plan"
    var id: String { rawValue }
}

private struct EditorRequest: Identifiable {
    let id = UUID()
    let kind: RecordKind
    let existing: ItineraryRecord?
    let revision: Int
    init(kind: RecordKind, revision: Int) { self.kind = kind; existing = nil; self.revision = revision }
    init(existing: ItineraryRecord, revision: Int) { kind = existing.kind; self.existing = existing; self.revision = revision }
}

private struct ItineraryRow: View {
    let record: ItineraryRecord
    let isDraft: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 13) {
            RecordKindIcon(kind: record.kind)
            VStack(alignment: .leading, spacing: 7) {
                Text(record.title).font(.headline).foregroundStyle(.primary)
                if record.allDay {
                    Text("All day").font(.caption).foregroundStyle(.secondary)
                } else if let start = LocalTripDate.time(record.start) {
                    Text(timeLabel(start)).font(.caption.weight(.medium)).foregroundStyle(WayPointStyle.teal)
                }
                if !record.place.venue.isEmpty {
                    Text(record.place.venue).font(.subheadline).foregroundStyle(.primary)
                }
                if !record.place.address.isEmpty {
                    Label(record.place.address, systemImage: "mappin")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                if !record.notes.isEmpty {
                    Text(record.notes).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                if isDraft { LocalDraftBadge() }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                .padding(.top, 4)
        }
        .padding(16)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
        .accessibilityElement(children: .combine)
    }

    private func timeLabel(_ start: String) -> String {
        guard let end = LocalTripDate.time(record.end) else { return start }
        if record.start.prefix(10) == record.end.prefix(10) { return "\(start) – \(end)" }
        return "\(start) – \(LocalTripDate.day(record.end)), \(end)"
    }
}

private struct TripMapView: View {
    let records: [ItineraryRecord]
    let openRecord: (ItineraryRecord) -> Void
    @State private var position: MapCameraPosition = .automatic

    private var pinnedRecords: [ItineraryRecord] { records.filter { $0.place.hasCoordinate } }

    var body: some View {
        VStack(spacing: 0) {
            if pinnedRecords.isEmpty {
                ContentUnavailableView("No saved map pins", systemImage: "mappin.slash", description: Text("Choose an address in an itinerary item to save a place on the map."))
                    .frame(maxHeight: .infinity)
            } else {
                Map(position: $position) {
                    ForEach(pinnedRecords, id: \.viewIdentity) { record in
                        if let latitude = record.place.latitude, let longitude = record.place.longitude {
                            Annotation(record.title, coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: longitude)) {
                                Button { openRecord(record) } label: {
                                    Image(systemName: record.kind.symbol)
                                        .font(.headline)
                                        .foregroundStyle(.white)
                                        .frame(width: 44, height: 44)
                                        .background(WayPointStyle.color(for: record.kind), in: Circle())
                                        .overlay(Circle().stroke(.white, lineWidth: 2))
                                        .shadow(radius: 3, y: 2)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("\(record.title), \(record.kind.title)")
                                .accessibilityHint("Open itinerary details")
                            }
                        }
                    }
                }
                .mapControls { MapCompass(); MapScaleView() }
                .overlay(alignment: .topTrailing) {
                    Button { position = .automatic } label: {
                        Label("Show all pins", systemImage: "arrow.up.left.and.arrow.down.right")
                            .font(.caption.weight(.semibold))
                            .padding(12)
                            .background(.regularMaterial, in: Capsule())
                    }
                    .padding(12)
                }
            }
            Label("Map imagery needs a connection. Saved trip details remain available offline.", systemImage: "info.circle")
                .font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(.regularMaterial)
        }
    }
}

private extension ItineraryRecord {
    var viewIdentity: String { kind.rawValue + ":" + id }
}
