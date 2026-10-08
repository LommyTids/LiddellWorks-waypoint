import SwiftUI
import WayPointCore

/// One editor for all four itinerary kinds. The original record is retained so
/// fields not exposed by this first UI (including raw data) survive.
@MainActor
struct RecordEditorView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let tripID: String
    let kind: RecordKind
    let existing: ItineraryRecord?
    let expectedRevision: Int
    @State private var draft: ItineraryRecord
    @State private var latitude: String
    @State private var longitude: String
    @State private var arrivalAddress = ""
    @State private var arrivalLatitude = ""
    @State private var arrivalLongitude = ""
    @State private var flightNumber = ""
    @State private var transportMode = ""
    @State private var destinationID = ""
    @State private var query = ""
    @State private var results: [Place] = []
    @State private var searching = false
    @State private var searchMessage: String?
    @State private var errorMessage: String?
    @State private var confirmDelete = false
    @State private var search = ApplePlaceSearch()

    init(tripID: String, kind: RecordKind, existing: ItineraryRecord? = nil, expectedRevision: Int, initialParticipants: [String] = []) {
        self.tripID = tripID
        self.kind = kind
        self.existing = existing
        self.expectedRevision = expectedRevision
        let record = existing ?? ItineraryRecord(id: UUID().uuidString, tripID: tripID, kind: kind, title: "", companions: initialParticipants)
        _draft = State(initialValue: record)
        _latitude = State(initialValue: record.place.latitude.map { String($0) } ?? "")
        _longitude = State(initialValue: record.place.longitude.map { String($0) } ?? "")
        _arrivalAddress = State(initialValue: Self.rawText(record.raw["toLocation"]))
        _arrivalLatitude = State(initialValue: Self.rawText(record.raw["toLat"]))
        _arrivalLongitude = State(initialValue: Self.rawText(record.raw["toLng"]))
        _flightNumber = State(initialValue: Self.rawText(record.raw["flightNumber"]))
        _transportMode = State(initialValue: Self.rawText(record.raw["mode"]))
        _destinationID = State(initialValue: Self.rawIdentifier(record.raw["destinationId"]))
    }

    private var canEdit: Bool {
        guard let trip = model.trip(id: tripID) else { return false }
        if trip.role.allowsAddingAndDeleting { return true }
        guard let existing else { return false }
        return TripParticipant.canEdit(existing, in: trip)
    }

    private var participants: [TripParticipant] {
        guard let trip = model.trip(id: tripID) else { return [] }
        return TripParticipant.all(in: trip)
    }

    private var destinations: [ItineraryRecord] {
        model.trip(id: tripID)?.records.filter { $0.kind == .destination } ?? []
    }

    private static func rawIdentifier(_ value: JSONValue?) -> String {
        switch value {
        case .string(let value): return value
        case .number(let value) where value.isFinite && value.rounded() == value && abs(value) <= 9_007_199_254_740_991:
            return String(Int64(value))
        default: return ""
        }
    }

    private var canDelete: Bool {
        existing != nil && (model.trip(id: tripID)?.role.allowsAddingAndDeleting ?? false)
    }

    private var address: Binding<String> {
        Binding(get: { draft.place.address }, set: { value in
            guard draft.place.address != value else { return }
            draft.place.address = value
            latitude = ""
            longitude = ""
        })
    }

    var body: some View {
        Form {
            Group {
                Section {
                    DraftNotice(isDemo: model.isDemo)
                    if !canEdit {
                        Label("Read-only item. Contributors can edit only existing items tagged to them.", systemImage: "lock")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section(kind.title) {
                    TextField(kind == .transport ? "Carrier or service name" : "Title", text: $draft.title)
                    if kind == .transport {
                        TextField("Mode (flight, train, car…)", text: $transportMode)
                        TextField("Flight number (optional)", text: $flightNumber)
                            .textInputAutocapitalization(.characters)
                    }
                    TextField("Notes", text: $draft.notes, axis: .vertical)
                        .lineLimit(3...8)
                }
                .disabled(!canEdit || model.isBusy)
                if kind == .activity || kind == .accommodation {
                    Section("Destination") {
                        Picker("Destination", selection: $destinationID) {
                            Text("No destination").tag("")
                            ForEach(destinations) { destination in Text(destination.title).tag(destination.id) }
                            if !destinationID.isEmpty && !destinations.contains(where: { $0.id == destinationID }) {
                                Text("Saved destination unavailable").tag(destinationID)
                            }
                        }
                        .disabled(!canEdit || model.isBusy || model.trip(id: tripID)?.role.allowsAddingAndDeleting != true)
                    }
                }
                dateSection
                    .disabled(!canEdit || model.isBusy)
                placeSection
                    .disabled(!canEdit || model.isBusy)
                if kind == .transport { arrivalSection.disabled(!canEdit || model.isBusy) }
                Section {
                    if model.trip(id: tripID)?.role.allowsAddingAndDeleting == true {
                        Button("All current travellers") { draft.companions = participants.map(\.id) }
                            .disabled(model.isBusy)
                        Button("Clear people") { draft.companions = [] }
                            .disabled(model.isBusy)
                        ForEach(participants) { participant in
                            Toggle(participant.name, isOn: Binding(
                                get: { draft.companions.contains(participant.id) },
                                set: { selected in
                                    if selected { if !draft.companions.contains(participant.id) { draft.companions.append(participant.id) } }
                                    else { draft.companions.removeAll { $0 == participant.id } }
                                }))
                        }
                        .disabled(model.isBusy)
                    } else {
                        if let trip = model.trip(id: tripID) {
                            ParticipantNames(trip: trip, ids: draft.companions)
                        }
                    }
                } header: {
                    Text("Who is this for?")
                } footer: {
                    Text("Review the named travellers before saving. No people assigned means unassigned, not everyone. Create and link people in the web app; contributors cannot change assignments.")
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red).accessibilityLabel("Error: \(errorMessage)") }
                }
                if canDelete {
                    Section {
                        Button("Delete item", role: .destructive) { confirmDelete = true }
                            .disabled(model.isBusy)
                    } footer: {
                        Text(model.isDemo ? "This deletion stays in your local demo." : "The deletion is saved offline and sent to WayPoint on your next sync.")
                    }
                }
            }
            .listRowBackground(WayPointStyle.surface)
        }
        .atlasForm()
        .navigationTitle(existing == nil ? "New \(kind.title.lowercased())" : kind.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.accessibilityIdentifier("record-editor-close") }
            if canEdit {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save)
                        .tint(WayPointStyle.amber)
                        .disabled(model.isBusy || draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .confirmationDialog("Delete this itinerary item?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete item", role: .destructive) {
                guard canDelete, let existing else { return }
                do { try model.delete(record: existing, expectedRevision: expectedRevision); dismiss() }
                catch { errorMessage = error.localizedDescription }
            }
        } message: { Text("This queues a deletion for your next sync. In demo mode it stays on this device.") }
        .task(id: query) { await searchPlaces() }
        .onChange(of: draft.start) { previous, current in
            if existing == nil && (draft.end.isEmpty || draft.end == previous) { draft.end = current }
        }
    }

    private var dateSection: some View {
        Section {
            Toggle("All day", isOn: $draft.allDay)
                .onChange(of: draft.allDay) { _, allDay in
                    if allDay {
                        draft.start = String(draft.start.prefix(10))
                        draft.end = String(draft.end.prefix(10))
                    }
                }
            LocalDateFields(label: kind == .transport ? "Departure" : "Start", value: $draft.start, allDay: draft.allDay)
            LocalDateFields(label: kind == .transport ? "Arrival" : "End", value: $draft.end, allDay: draft.allDay)
            if draft.end.isEmpty && !draft.start.isEmpty {
                Button("Set end to start") { draft.end = draft.start }
            }
            if let zone = draft.timeZoneID, !zone.isEmpty {
                LabeledContent("Saved timezone", value: zone)
            }
        } header: { Text("When") } footer: {
            Text(kind == .transport
                 ? "Use local departure and arrival times. No timezone conversion is applied. Leave dates blank if not planned."
                 : "Dates and times are local to the plan, not converted to your phone’s timezone. Leave dates blank if not planned.")
        }
    }

    private var placeSection: some View {
        Section {
            if kind != .transport { TextField("Venue name (optional)", text: $draft.place.venue) }
            TextField("Address (optional)", text: address, axis: .vertical)
                .lineLimit(1...3)
            TextField("Search Apple Maps (3+ characters)", text: $query)
                .autocorrectionDisabled()
            if searching { ProgressView("Finding places…") }
            if let searchMessage { Text(searchMessage).font(.caption).foregroundStyle(.secondary) }
            ForEach(Array(results.enumerated()), id: \.offset) { _, place in
                Button {
                    draft.place.address = place.address
                    if draft.place.venue.isEmpty { draft.place.venue = place.venue }
                    latitude = place.latitude.map { String($0) } ?? ""
                    longitude = place.longitude.map { String($0) } ?? ""
                    query = ""
                    results = []
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(place.venue.isEmpty ? place.address : place.venue).font(.subheadline.weight(.medium))
                        Text(place.address).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            DisclosureGroup("Map pin / manual coordinates") {
                TextField("Latitude (−90 to 90)", text: $latitude)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityLabel("Latitude, minus 90 to 90")
                TextField("Longitude (−180 to 180)", text: $longitude)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityLabel("Longitude, minus 180 to 180")
                Button("Clear saved pin") { latitude = ""; longitude = "" }
                Text("Venue is a text label. Select an address result or enter both coordinates to position the pin. Editing the address clears the previous pin until you select or enter new coordinates.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        } header: { Text(kind == .transport ? "Departure place" : "Where") } footer: {
            Text(kind == .transport
                 ? "Search the departure place with Apple Maps, or enter its address and coordinates manually."
                 : "Apple Maps search needs internet access; manual entry works offline.")
        }
    }

    private var arrivalSection: some View {
        Section {
            TextField("Arrival address (optional)", text: Binding(
                get: { arrivalAddress },
                set: { value in
                    if value != arrivalAddress { arrivalAddress = value; arrivalLatitude = ""; arrivalLongitude = "" }
                }), axis: .vertical)
                .lineLimit(1...3)
            DisclosureGroup("Arrival pin / manual coordinates") {
                TextField("Latitude (−90 to 90)", text: $arrivalLatitude)
                TextField("Longitude (−180 to 180)", text: $arrivalLongitude)
                Button("Clear arrival pin") { arrivalLatitude = ""; arrivalLongitude = "" }
            }
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        } header: { Text("Arrival place") } footer: {
            Text("Arrival address and coordinates are saved separately from departure. Editing the address clears its old pin. Use both coordinates, or leave both blank.")
        }
    }

    private static func rawText(_ value: JSONValue?) -> String {
        switch value {
        case .string(let text): return text
        case .number(let number): return String(number)
        default: return ""
        }
    }

    @MainActor
    private func searchPlaces() async {
        let requested = query
        results = []
        searchMessage = nil
        searching = false
        guard canEdit, requested.trimmingCharacters(in: .whitespacesAndNewlines).count >= 3 else { return }
        do {
            try await Task.sleep(nanoseconds: 400_000_000)
            try Task.checkCancellation()
            guard requested == query else { return }
            searching = true
            let found = try await search.search(requested)
            try Task.checkCancellation()
            guard requested == query else { return }
            results = found
            searching = false
            if found.isEmpty { searchMessage = "No matches. Try adding a city, or enter the address and coordinates manually." }
        } catch {
            guard !Task.isCancelled, requested == query else { return }
            searching = false
            searchMessage = "Search unavailable. You can still enter an address and coordinates manually."
        }
    }

    private func save() {
        guard canEdit else { return }
        do {
            var updated = draft
            let lat = latitude.trimmingCharacters(in: .whitespacesAndNewlines)
            let lon = longitude.trimmingCharacters(in: .whitespacesAndNewlines)
            if lat.isEmpty && lon.isEmpty {
                updated.place.latitude = nil
                updated.place.longitude = nil
            } else {
                guard let latitude = Double(lat), let longitude = Double(lon), latitude.isFinite, longitude.isFinite,
                      (-90...90).contains(latitude), (-180...180).contains(longitude) else {
                    throw LocalWorkspaceError.invalidRecord("Enter both valid coordinates, or clear both fields.")
                }
                updated.place.latitude = latitude
                updated.place.longitude = longitude
            }
            if kind == .transport {
                var fields: [String: JSONValue] = [:]
                if case .object(let original) = updated.raw { fields = original }
                if flightNumber != Self.rawText(draft.raw["flightNumber"]) { fields["flightNumber"] = .string(flightNumber) }
                if transportMode != Self.rawText(draft.raw["mode"]) { fields["mode"] = .string(transportMode) }
                if arrivalAddress != Self.rawText(draft.raw["toLocation"]) { fields["toLocation"] = .string(arrivalAddress) }
                let arrivalLat = arrivalLatitude.trimmingCharacters(in: .whitespacesAndNewlines)
                let arrivalLon = arrivalLongitude.trimmingCharacters(in: .whitespacesAndNewlines)
                if !arrivalLat.isEmpty || !arrivalLon.isEmpty {
                    guard let lat = Double(arrivalLat), let lon = Double(arrivalLon), lat.isFinite, lon.isFinite,
                          (-90...90).contains(lat), (-180...180).contains(lon) else {
                        throw LocalWorkspaceError.invalidRecord("Enter both valid arrival coordinates, or clear both fields.")
                    }
                }
                if arrivalLatitude != Self.rawText(draft.raw["toLat"]) { fields["toLat"] = Double(arrivalLat).map(JSONValue.number) ?? .string("") }
                if arrivalLongitude != Self.rawText(draft.raw["toLng"]) { fields["toLng"] = Double(arrivalLon).map(JSONValue.number) ?? .string("") }
                if arrivalAddress != Self.rawText(draft.raw["toLocation"])
                    || arrivalLatitude != Self.rawText(draft.raw["toLat"])
                    || arrivalLongitude != Self.rawText(draft.raw["toLng"]) {
                    for key in ["toLocationRef", "toLocationMethod", "toLocationGranularity", "toLocationKindLabel"] { fields[key] = .string("") }
                    fields["toLocationStale"] = .bool(false)
                }
                updated.raw = .object(fields)
            }
            if (kind == .activity || kind == .accommodation),
               destinationID != Self.rawIdentifier(draft.raw["destinationId"]) {
                var fields: [String: JSONValue] = [:]
                if case .object(let original) = updated.raw { fields = original }
                fields["destinationId"] = .string(destinationID)
                updated.raw = .object(fields)
            }
            try model.save(record: updated, expectedRevision: expectedRevision)
            dismiss()
        } catch { errorMessage = error.localizedDescription }
    }
}

/// String-backed civil dates avoid converting a travel time through an absolute
/// instant or the device timezone. This also preserves untouched server values.
private struct LocalDateFields: View {
    let label: String
    @Binding var value: String
    let allDay: Bool

    private var date: Binding<String> {
        Binding(get: { String(value.prefix(10)) }, set: { newDate in
            let existingTime = value.split(separator: "T", maxSplits: 1).dropFirst().first.map(String.init) ?? ""
            value = newDate.isEmpty ? "" : newDate + (!allDay && !existingTime.isEmpty ? "T" + existingTime : "")
        })
    }

    private var time: Binding<String> {
        Binding(get: { value.split(separator: "T", maxSplits: 1).dropFirst().first.map(String.init) ?? "" }, set: { newTime in
            let day = String(value.prefix(10))
            value = day + (newTime.isEmpty ? "" : "T" + newTime)
        })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(.subheadline.weight(.semibold))
            HStack(spacing: 12) {
                TextField("YYYY-MM-DD", text: date)
                    .accessibilityLabel("\(label) date, year month day")
                if !allDay {
                    TextField("HH:mm", text: time)
                        .frame(maxWidth: 100)
                        .disabled(value.isEmpty)
                        .accessibilityLabel("\(label) local time, 24 hour")
                }
            }
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .textFieldStyle(.roundedBorder)
        }
        .padding(.vertical, 4)
    }
}
