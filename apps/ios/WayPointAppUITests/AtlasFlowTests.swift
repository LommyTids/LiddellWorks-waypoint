import XCTest

final class AtlasFlowTests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    @MainActor
    func testLoginAndHelpKeepExistingCodeFlow() {
        let app = XCUIApplication()
        app.launch()
        let login = app.buttons["Log in to WayPoint"]
        XCTAssertTrue(login.waitForExistence(timeout: 10))
        capture("Welcome", app: app)
        login.tap()
        let code = app.textFields["login-code"]
        XCTAssertTrue(code.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["login-submit"].isEnabled)
        capture("Login", app: app)
        code.tap()
        code.typeText("123")
        XCTAssertTrue(app.buttons["login-submit"].isEnabled)
        app.buttons["Done"].tap()
        app.buttons["Need help logging in?"].tap()
        XCTAssertTrue(app.navigationBars["Login help"].waitForExistence(timeout: 5))
        capture("Login help", app: app)
        app.navigationBars["Login help"].buttons["Done"].tap()
        XCTAssertEqual(code.value as? String, "123")
        // No credentials are submitted and no real account is used.
    }

    @MainActor
    func testDemoNavigationCollapseAndParticipantEditor() {
        let app = XCUIApplication()
        app.launch()
        app.buttons["Explore a demo trip"].tap()
        let trip = app.buttons.containing(.staticText, identifier: "A long weekend in Lisbon").firstMatch
        XCTAssertTrue(trip.waitForExistence(timeout: 10))
        capture("Trips", app: app)
        trip.tap()
        XCTAssertTrue(app.buttons["Collapse all"].waitForExistence(timeout: 5))
        capture("Agenda", app: app)
        app.buttons["Collapse all"].tap()
        XCTAssertTrue(app.buttons["Expand all"].exists)
        app.buttons["Expand all"].tap()
        app.buttons["Map"].tap()
        capture("Map", app: app)
        app.buttons["Plan"].tap()
        XCTAssertTrue(app.staticTexts["Areas"].exists)
        app.buttons["People"].tap()
        XCTAssertTrue(app.staticTexts["Travellers"].exists)
        app.buttons["More"].tap()
        XCTAssertTrue(app.staticTexts["Your access"].exists)
        app.buttons["Itinerary"].tap()
        app.buttons["Agenda"].tap()
        app.buttons["Trip owner"].tap()
        app.buttons["add-activity"].tap()
        XCTAssertTrue(app.navigationBars["New activity"].waitForExistence(timeout: 5))
        app.swipeUp()
        XCTAssertTrue(app.switches["Trip owner"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.switches["Trip owner"].value as? String, "1")
        capture("Participant editor", app: app)
        app.buttons["Close"].tap()
    }

    @MainActor
    func testAccessibilityTextKeepsLoginAndAgendaReachable() {
        let app = XCUIApplication()
        app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        let login = app.buttons["Log in to WayPoint"]
        XCTAssertTrue(login.waitForExistence(timeout: 10))
        XCTAssertTrue(login.isHittable)
        capture("Welcome large text", app: app)
        login.tap()
        let code = app.textFields["login-code"]
        for _ in 0..<4 where !code.isHittable { app.swipeUp() }
        XCTAssertTrue(code.isHittable)
        capture("Login large text", app: app)
        app.navigationBars["Log in"].buttons.firstMatch.tap()
        app.buttons["Explore a demo trip"].tap()
        let trip = app.buttons.containing(.staticText, identifier: "A long weekend in Lisbon").firstMatch
        XCTAssertTrue(trip.waitForExistence(timeout: 10))
        trip.tap()
        let collapse = app.buttons["Collapse all"]
        capture("Agenda large text initial", app: app)
        for _ in 0..<4 where !collapse.isHittable { app.scrollViews["trip-itinerary"].swipeUp() }
        XCTAssertTrue(collapse.isHittable)
        capture("Agenda large text before collapse", app: app)
        collapse.tap()
        capture("Agenda large text after collapse", app: app)
        XCTAssertTrue(app.buttons["Expand all"].waitForExistence(timeout: 5))
        capture("Agenda large text", app: app)
    }

    @MainActor
    private func capture(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
