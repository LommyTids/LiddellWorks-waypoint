#!/usr/bin/env python3
"""Regenerate the checked-in Xcode project, using only Python's standard library."""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT / 'WayPoint.xcodeproj'
PROJECT.mkdir(exist_ok=True)
objects = {}
def ident(label):
    return hashlib.sha256(label.encode()).hexdigest()[:24].upper()
def q(value):
    return json.dumps(str(value))
def add(label, body):
    key = ident(label)
    objects[key] = body
    return key

def config(label, settings):
    return add(label, 'isa = XCBuildConfiguration; buildSettings = { ' + ' '.join(k+' = '+v+';' for k,v in settings.items()) + ' }; name = '+q(label.split(':')[-1])+';')
def configs(label, base, debug_extra=None):
    ids=[]
    for mode in ['Debug','Release']:
        settings=dict(base)
        settings.update({'SWIFT_OPTIMIZATION_LEVEL':q('-Onone' if mode=='Debug' else '-O')})
        if mode == 'Debug':
            settings.update({'ENABLE_TESTABILITY':'YES','SWIFT_ACTIVE_COMPILATION_CONDITIONS':q('DEBUG $(inherited)')})
            settings.update(debug_extra or {})
        ids.append(config(label+':'+mode,settings))
    return add(label+':configlist','isa = XCConfigurationList; buildConfigurations = ('+','.join(ids)+',); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')

source_refs=[]
source_builds=[]
for file in sorted((ROOT/'WayPointApp').rglob('*.swift')):
    rel=file.relative_to(ROOT).as_posix()
    ref=add('file:'+rel,'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = '+q(rel)+'; sourceTree = SOURCE_ROOT;')
    build=add('build:'+rel,'isa = PBXBuildFile; fileRef = '+ref+';')
    source_refs.append(ref); source_builds.append(build)

app_product=add('product','isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = WayPoint.app; sourceTree = BUILT_PRODUCTS_DIR;')
products=add('products','isa = PBXGroup; children = ('+app_product+',); name = Products; sourceTree = "<group>";')
main_group=add('main','isa = PBXGroup; children = ('+','.join(source_refs+[products])+',); sourceTree = "<group>";')
package=add('package','isa = XCLocalSwiftPackageReference; relativePath = ".";')
package_product=add('package-product','isa = XCSwiftPackageProductDependency; package = '+package+'; productName = WayPointCore;')
package_build=add('package-build','isa = PBXBuildFile; productRef = '+package_product+';')
sources=add('sources','isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ('+','.join(source_builds)+',); runOnlyForDeploymentPostprocessing = 0;')
frameworks=add('frameworks','isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = ('+package_build+',); runOnlyForDeploymentPostprocessing = 0;')
resources=add('resources','isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;')
project_cfg=configs('Project',{'CLANG_ENABLE_MODULES':'YES','IPHONEOS_DEPLOYMENT_TARGET':'17.0','SDKROOT':q('iphoneos'),'SWIFT_VERSION':'5.0','SWIFT_STRICT_CONCURRENCY':q('targeted'),'GCC_C_LANGUAGE_STANDARD':q('gnu17')})
app_cfg=configs('App',{'PRODUCT_NAME':q('$(TARGET_NAME)'),'PRODUCT_BUNDLE_IDENTIFIER':q('com.liddellworks.waypoint'),'MARKETING_VERSION':q('0.1.0'),'CURRENT_PROJECT_VERSION':'1','CODE_SIGN_STYLE':q('Automatic'),'GENERATE_INFOPLIST_FILE':'YES','INFOPLIST_KEY_CFBundleDisplayName':q('WayPoint'),'INFOPLIST_KEY_LSApplicationCategoryType':q('public.app-category.travel'),'INFOPLIST_KEY_UIApplicationSceneManifest_Generation':'YES','INFOPLIST_KEY_UILaunchScreen_Generation':'YES','INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents':'YES','INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone':q('UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight'),'INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad':q('UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight'),'TARGETED_DEVICE_FAMILY':q('1,2'),'SUPPORTED_PLATFORMS':q('iphoneos iphonesimulator'),'SUPPORTS_MACCATALYST':'NO','LD_RUNPATH_SEARCH_PATHS':q('$(inherited) @executable_path/Frameworks'),'ENABLE_PREVIEWS':'YES'})
target=add('target','isa = PBXNativeTarget; buildConfigurationList = '+app_cfg+'; buildPhases = ('+','.join([sources,frameworks,resources])+',); buildRules = (); dependencies = (); name = WayPoint; packageProductDependencies = ('+package_product+',); productName = WayPoint; productReference = '+app_product+'; productType = "com.apple.product-type.application";')
test_files = sorted((ROOT/'WayPointAppTests').rglob('*.swift'))
test_target = None
if test_files:
    test_refs=[]; test_builds=[]
    for file in test_files:
        rel=file.relative_to(ROOT).as_posix()
        ref=add('file:'+rel,'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = '+q(rel)+'; sourceTree = SOURCE_ROOT;')
        test_refs.append(ref)
        test_builds.append(add('build:'+rel,'isa = PBXBuildFile; fileRef = '+ref+';'))
    test_product=add('test-product','isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = WayPointAppTests.xctest; sourceTree = BUILT_PRODUCTS_DIR;')
    objects[products]='isa = PBXGroup; children = ('+app_product+','+test_product+',); name = Products; sourceTree = "<group>";'
    objects[main_group]='isa = PBXGroup; children = ('+','.join(source_refs+test_refs+[products])+',); sourceTree = "<group>";'
    test_sources=add('test-sources','isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ('+','.join(test_builds)+',); runOnlyForDeploymentPostprocessing = 0;')
    test_package_build=add('test-package-build','isa = PBXBuildFile; productRef = '+package_product+';')
    test_frameworks=add('test-frameworks','isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = ('+test_package_build+',); runOnlyForDeploymentPostprocessing = 0;')
    test_cfg=configs('Tests',{'PRODUCT_NAME':q('$(TARGET_NAME)'),'PRODUCT_BUNDLE_IDENTIFIER':q('com.liddellworks.waypoint.tests'),'GENERATE_INFOPLIST_FILE':'YES','TEST_HOST':q('$(BUILT_PRODUCTS_DIR)/WayPoint.app/WayPoint'),'BUNDLE_LOADER':q('$(TEST_HOST)'),'CODE_SIGN_STYLE':q('Automatic'),'TARGETED_DEVICE_FAMILY':q('1,2'),'SUPPORTED_PLATFORMS':q('iphoneos iphonesimulator')})
    proxy=add('test-proxy','isa = PBXContainerItemProxy; containerPortal = '+ident('project')+'; proxyType = 1; remoteGlobalIDString = '+target+'; remoteInfo = WayPoint;')
    dependency=add('test-dependency','isa = PBXTargetDependency; target = '+target+'; targetProxy = '+proxy+';')
    test_target=add('test-target','isa = PBXNativeTarget; buildConfigurationList = '+test_cfg+'; buildPhases = ('+test_sources+','+test_frameworks+',); buildRules = (); dependencies = ('+dependency+',); name = WayPointAppTests; packageProductDependencies = ('+package_product+',); productName = WayPointAppTests; productReference = '+test_product+'; productType = "com.apple.product-type.bundle.unit-test";')
proj=add('project','isa = PBXProject; attributes = { BuildIndependentTargetsInParallel = YES; LastUpgradeCheck = 1600; TargetAttributes = { '+target+' = { CreatedOnToolsVersion = 16.0; }; }; }; buildConfigurationList = '+project_cfg+'; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en,Base,); mainGroup = '+main_group+'; packageReferences = ('+package+',); productRefGroup = '+products+'; projectDirPath = ""; projectRoot = ""; targets = ('+target+',);')
if test_target:
    objects[proj]=objects[proj].replace('targets = ('+target+',);','targets = ('+target+','+test_target+',);')
text='// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n'
text+='\n'.join(k+' = { '+v+' };' for k,v in sorted(objects.items()))
text+='\n}; rootObject = '+proj+'; }\n'
(PROJECT/'project.pbxproj').write_text(text)
schemes=PROJECT/'xcshareddata'/'xcschemes'
schemes.mkdir(parents=True,exist_ok=True)
(schemes/'WayPoint.xcscheme').write_text('''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.3">
 <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries>
 <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">
 <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="'''+target+'''" BuildableName="WayPoint.app" BlueprintName="WayPoint" ReferencedContainer="container:WayPoint.xcodeproj"/>
 </BuildActionEntry></BuildActionEntries></BuildAction>
 <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables/></TestAction>
 <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="'''+target+'''" BuildableName="WayPoint.app" BlueprintName="WayPoint" ReferencedContainer="container:WayPoint.xcodeproj"/></BuildableProductRunnable></LaunchAction>
 <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"/>
 <AnalyzeAction buildConfiguration="Debug"/>
 <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
''')
if test_target:
    scheme_path=schemes/'WayPoint.xcscheme'
    scheme_path.write_text(scheme_path.read_text().replace('<Testables/>','<Testables><TestableReference skipped="NO"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="'+test_target+'" BuildableName="WayPointAppTests.xctest" BlueprintName="WayPointAppTests" ReferencedContainer="container:WayPoint.xcodeproj"/></TestableReference></Testables>'))
workspace=PROJECT/'project.xcworkspace'
workspace.mkdir(exist_ok=True)
(workspace/'contents.xcworkspacedata').write_text('<?xml version="1.0" encoding="UTF-8"?><Workspace version="1.0"><FileRef location="self:"></FileRef></Workspace>\n')
print(f'Generated WayPoint.xcodeproj with {len(source_refs)} Swift app files')
