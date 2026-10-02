import SwiftUI
import WayPointCore

/// A conflict never resolves through an accidental retry. The user sees both copies
/// and explicitly chooses whether to keep their pending change or use the server.
struct PendingChangeView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let mutationID: UUID
    @State private var confirmDiscard = false
    @State private var confirmReapply = false
    @State private var errorMessage: String?

    private var mutation: PendingMutation? {
        model.workspace?.mutations.first { $0.id == mutationID }
    }

    var body: some View {
        Form {
            if let mutation {
                Section("Your pending change") {
                    LabeledContent("Trip", value: model.trip(id: mutation.tripID)?.name ?? "Unavailable trip")
                    LabeledContent("Status", value: mutation.status == .conflict ? "Needs review" : mutation.status == .blocked ? "Blocked" : "Waiting to sync")
                    if let record = model.localRecord(for: mutation) { recordSummary(record) }
                    else { Text(mutation.operation == .delete ? "Delete this item" : "Create or update trip") }
                    if let message = mutation.message { Text(message).font(.footnote).foregroundStyle(.secondary) }
                }
                if mutation.status == .conflict || (mutation.status == .blocked && model.localRecord(for: mutation) != nil) {
                    Section("Current server copy") {
                        if let server = model.serverRecord(for: mutation) { recordSummary(server) }
                        else { Text("This item is missing or unavailable in the latest downloaded copy.") }
                    }
                    Section {
                        Button("Keep my change and queue again") { confirmReapply = true }
                            .disabled(model.isBusy || model.isDraftSubmitted(id: mutationID))
                    } footer: {
                        Text("Review both copies first. This queues your change against the current server version; it may replace newer details when you sync.")
                    }
                }
                Section {
                    Button(model.isDemo ? "Clear demo change marker" : "Discard this pending change", role: .destructive) { confirmDiscard = true }
                        .disabled(model.isBusy || model.isDraftSubmitted(id: mutationID))
                } footer: {
                    Text(model.isDemo ? "Demo edits are local plans. Clearing this marker keeps the edited plan." : model.isDraftSubmitted(id: mutationID)
                         ? "This change was sent but its result is still uncertain. Sync again to check it before discarding."
                         : "Discarding removes your local change and restores the latest downloaded version.")
                }
                if let errorMessage { Section { Text(errorMessage).foregroundStyle(.red) } }
            } else {
                Section { Label("This change has been resolved.", systemImage: "checkmark.circle") }
            }
        }
        .navigationTitle("Review change")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Discard your pending change?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Discard change", role: .destructive) {
                do { try model.discardDraft(id: mutationID); dismiss() }
                catch { errorMessage = error.localizedDescription }
            }
        }
        .confirmationDialog("Queue your version against the latest server copy?", isPresented: $confirmReapply, titleVisibility: .visible) {
            Button("Queue my version") {
                do { try model.reapplyDraft(id: mutationID); dismiss() }
                catch { errorMessage = error.localizedDescription }
            }
        }
    }

    @ViewBuilder private func recordSummary(_ record: ItineraryRecord) -> some View {
        Text(record.title).font(.headline)
        if !record.start.isEmpty { LabeledContent("Start", value: civilTime(record.start)) }
        if !record.end.isEmpty { LabeledContent("End", value: civilTime(record.end)) }
        if !record.companions.isEmpty { LabeledContent("Participant tags", value: "\(record.companions.count)") }
        if !record.place.venue.isEmpty { LabeledContent("Venue", value: record.place.venue) }
        if !record.place.address.isEmpty { LabeledContent("Address", value: record.place.address) }
        if !record.notes.isEmpty { Text(record.notes) }
    }

    private func civilTime(_ value: String) -> String {
        let day = LocalTripDate.day(value)
        return LocalTripDate.time(value).map { day + ", " + $0 } ?? day
    }
}

struct NewTripView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var includeDates = false
    @State private var startDate = Date()
    @State private var endDate = Date()
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section("Trip") {
                TextField("Trip name", text: $name)
                    .textInputAutocapitalization(.words)
                Toggle("Set travel dates", isOn: $includeDates)
                if includeDates {
                    DatePicker("Start", selection: $startDate, displayedComponents: .date)
                    DatePicker("End", selection: $endDate, in: startDate..., displayedComponents: .date)
                }
            }
            .disabled(model.isBusy)
            Section {
                DraftNotice(isDemo: model.isDemo)
            }
            if let errorMessage { Section { Text(errorMessage).foregroundStyle(.red) } }
        }
        .environment(\.timeZone, LocalTripDate.carrierZone)
        .navigationTitle("New trip")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Create") {
                    do {
                        try model.createTrip(name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                                             startDate: includeDates ? LocalTripDate.encode(startDate, allDay: true) : "",
                                             endDate: includeDates ? LocalTripDate.encode(endDate, allDay: true) : "")
                        dismiss()
                    } catch { errorMessage = error.localizedDescription }
                }
                .disabled(model.isBusy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .onChange(of: startDate) { _, newValue in if endDate < newValue { endDate = newValue } }
    }
}
