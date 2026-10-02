#!/usr/bin/env python3
"""Non-compiler checks. Requires pip install tree-sitter tree-sitter-swift pbxproj.

These checks intentionally do not claim Swift type-checking or iOS execution.
"""
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET
from tree_sitter import Language, Parser
import tree_sitter_swift
from pbxproj import XcodeProject

root = Path(__file__).resolve().parents[1]
parser = Parser(Language(tree_sitter_swift.language()))
errors = []
sources = sorted(p for p in root.rglob('*.swift') if '.build' not in p.parts)
for source in sources:
    data = source.read_bytes()
    tree = parser.parse(data)
    stack = [tree.root_node]
    while stack:
        node = stack.pop()
        if node.type == 'ERROR' or node.is_missing:
            errors.append(f'{source.relative_to(root)}:{node.start_point.row + 1}: {node.type}')
        stack.extend(node.children)

project_path = root / 'WayPoint.xcodeproj/project.pbxproj'
project = XcodeProject.load(str(project_path))
if project is None:
    errors.append('Xcode project could not be parsed')
project_text = project_path.read_text()
referenced = set(re.findall(r'path = "(WayPointApp/[^"\n]+\.swift)"', project_text))
actual = {p.relative_to(root).as_posix() for p in (root / 'WayPointApp').rglob('*.swift')}
if referenced != actual:
    errors.append(f'Project source mismatch: missing={actual-referenced}, stale={referenced-actual}')
test_refs = set(re.findall(r'path = "(WayPointAppTests/[^"\n]+\.swift)"', project_text))
test_actual = {p.relative_to(root).as_posix() for p in (root / 'WayPointAppTests').rglob('*.swift')}
if test_refs != test_actual:
    errors.append('App test target source membership mismatch')
for xml in [root / 'WayPoint.xcodeproj/xcshareddata/xcschemes/WayPoint.xcscheme',
            root / 'WayPoint.xcodeproj/project.xcworkspace/contents.xcworkspacedata']:
    ET.parse(xml)

api = (root / 'WayPointApp/Services/WayPointAPI.swift').read_text()
if 'send(.data, method: "POST"' in api:
    errors.append('Legacy write route must remain disabled')
for token in ['httpCookieStorage = nil', 'urlCache = nil', 'completionHandler(nil)', 'wp_session=']:
    if token not in api:
        errors.append(f'Missing network isolation check: {token}')

tests = sum(len(re.findall(r'func test\w+', p.read_text())) for folder in ['Tests', 'WayPointAppTests'] for p in (root / folder).rglob('*.swift'))
if errors:
    print('\n'.join(errors))
    sys.exit(1)
print(f'PASS: {len(sources)} Swift files parsed without syntax errors.')
print(f'PASS: Xcode project parsed; all {len(actual)} app source files included; scheme/workspace XML parsed.')
print(f'PASS: legacy write route disabled; network isolation source checks present.')
print(f'FOUND: {tests} XCTest cases (not executed; Swift/Xcode required).')
