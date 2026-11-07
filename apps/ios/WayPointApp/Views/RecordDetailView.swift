import SwiftUI
import WayPointCore

struct RecordDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let tripID: String
    let recordID: String
    let kind: RecordKind
    @State private var editor: DetailEditorRequest?

    var body: some View {
        Group {
            if let trip = model.trip(id: tripID),
               let record = trip.records.first(where: { $0.id == recordID && $0.kind == kind }) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        Text(record.title).font(WayPointType.display)
                            .foregroundStyle(WayPointStyle.navy)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityAddTraits(.isHeader)
                            .accessibilityIdentifier("record-detail-title")
                        if model.workspace?.mutations.contains(where: { $0.tripID == tripID && $0.recordID == recordID && $0.kind == kind }) == true {
                            LocalDraftBadge()
                        }
                        VStack(alignment: .leading, spacing: 16) {
                            detailRow("Dates", value: LocalTripDate.range(start: record.start, end: record.end), symbol: "calendar")
                            detailRow("Time", value: timeSummary(record), symbol: "clock")
                            if let zone = record.timeZoneID, !zone.isEmpty {
                                detailRow("Saved timezone", value: zone, symbol: "globe")
                            }
                            if !record.place.venue.isEmpty {
                                detailRow("Place", value: record.place.venue, symbol: "mappin")
                            }
                            if !record.place.address.isEmpty {
                                detailRow(kind == .transport ? "Departure" : "Address", value: record.place.address, symbol: "mappin.and.ellipse")
                            }
                            if kind == .transport {
                                let arrival = TripParticipant.text(record.raw["toLocation"])
                                let flight = TripParticipant.text(record.raw["flightNumber"])
                                if !arrival.isEmpty { detailRow("Arrival", value: arrival, symbol: "arrow.right") }
                                if !flight.isEmpty { detailRow("Flight number", value: flight, symbol: "airplane") }
                            }
                            detailRow("People", value: record.companions.isEmpty ? "No people assigned" : record.companions.map { TripParticipant.name(for: $0, in: trip) }.joined(separator: ", "), symbol: "person.2")
                        }
                        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
                        .atlasCard(cornerRadius: 12)
                        if !record.notes.isEmpty {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Notes").font(WayPointType.heading)
                                Text(record.notes).font(WayPointType.body)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .foregroundStyle(WayPointStyle.navy)
                            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
                            .atlasCard(cornerRadius: 12)
                        }
                        Text("Times are local to the plan or journey. They are not converted to your phone’s timezone.")
                            .font(.footnote).foregroundStyle(WayPointStyle.muted)
                    }
                    .padding(18).frame(maxWidth: 860).frame(maxWidth: .infinity)
                }
                .toolbar {
                    if TripParticipant.canEdit(record, in: trip) {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Edit") {
                                // Capture the displayed record and revision together;
                                // later refreshes must not silently rebase this edit.
                                editor = DetailEditorRequest(record: record, revision: trip.revision)
                            }
                            .tint(WayPointStyle.amber)
                            .disabled(model.isBusy)
                            .accessibilityIdentifier("record-edit")
                        }
                    }
                }
            } else {
                ContentUnavailableView("Plan unavailable", systemImage: "calendar.badge.exclamationmark", description: Text("It may have been removed or your access may have changed."))
            }
        }
        .background(WayPointStyle.canvas)
        .navigationTitle(kind.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.accessibilityIdentifier("record-detail-close") } }
        .sheet(item: $editor) { request in
            NavigationStack {
                RecordEditorView(tripID: tripID, kind: kind, existing: request.record,
                                 expectedRevision: request.revision)
            }
        }
    }

    private func detailRow(_ label: String, value: String, symbol: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol).font(.body).foregroundStyle(WayPointStyle.muted)
                .frame(width: 22).padding(.top, 2).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(label).font(WayPointType.micro).foregroundStyle(WayPointStyle.muted)
                Text(value).font(WayPointType.body).foregroundStyle(WayPointStyle.navy)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }

    private func timeSummary(_ record: ItineraryRecord) -> String {
        if record.allDay { return "All day" }
        guard let start = LocalTripDate.time(record.start) else { return "Time to be planned" }
        guard let end = LocalTripDate.time(record.end) else { return start }
        if record.start.prefix(10) == record.end.prefix(10) { return "\(start) – \(end)" }
        return "\(start) – \(LocalTripDate.day(record.end)), \(end)"
    }
}

private struct DetailEditorRequest: Identifiable {
    let id = UUID()
    let record: ItineraryRecord
    let revision: Int
}
