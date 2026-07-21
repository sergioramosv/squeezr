import { describe, it, expect } from 'vitest'
import { detectCodeLanguage, extractCodeStructure } from '../deterministic.js'
import { retrieveOriginal } from '../expand.js'

describe('detectCodeLanguage', () => {
  it('detects the existing languages', () => {
    expect(detectCodeLanguage("import x from 'y'\nexport function f(): void {}")).toBe('ts')
    expect(detectCodeLanguage('from os import path\ndef f():\n    pass')).toBe('py')
    expect(detectCodeLanguage('package main\nfunc main() {}')).toBe('go')
    expect(detectCodeLanguage('use std::io;\npub fn main() {}')).toBe('rs')
  })

  it('detects Java', () => {
    const java = 'package com.acme.app;\nimport java.util.List;\npublic class Service {\n  public void run() {}\n}'
    expect(detectCodeLanguage(java)).toBe('java')
  })

  it('detects C++ (has std::/class/namespace)', () => {
    const cpp = '#include <vector>\n#include <string>\nnamespace app {\nclass Widget {\n  void draw() {}\n};\n}'
    expect(detectCodeLanguage(cpp)).toBe('cpp')
  })

  it('detects C (includes, no C++ markers)', () => {
    const c = '#include <stdio.h>\n#include <stdlib.h>\nint main(int argc, char **argv) {\n  return 0;\n}'
    expect(detectCodeLanguage(c)).toBe('c')
  })

  it('returns null for non-code prose', () => {
    expect(detectCodeLanguage('This is a plain english log line.\nAnother sentence here.')).toBeNull()
  })
})

describe('extractCodeStructure — Java', () => {
  function bigJava(): string {
    const lines: string[] = ['package com.acme;', 'import java.util.List;', '', 'public class Orders {']
    for (let m = 0; m < 6; m++) {
      lines.push(`  public int method${m}(int a, int b) {`)
      for (let b = 0; b < 15; b++) lines.push(`    int local${b} = a + b + ${m};`)
      lines.push('    return a;')
      lines.push('  }')
    }
    lines.push('}')
    return lines.join('\n')
  }

  it('keeps signatures, elides bodies, and stays smaller', () => {
    const input = bigJava()
    const out = extractCodeStructure(input, 'java')
    expect(out).not.toBe(input)
    expect(out.length).toBeLessThan(input.length)
    // signatures survive
    expect(out.includes('public int method0(int a, int b)')).toBe(true)
    expect(out.includes('public class Orders')).toBe(true)
    // an omitted-lines marker is present
    expect(/implementation lines omitted|lines omitted/.test(out)).toBe(true)
  })

  it('is fully recoverable via the parent expand id', () => {
    const input = bigJava()
    const out = extractCodeStructure(input, 'java')
    const m = out.match(/squeezr_expand\("([0-9a-f]{6,})"\)/)
    expect(m).not.toBeNull()
    expect(retrieveOriginal(m![1])).toBe(input)
  })
})

describe('extractCodeStructure — C++', () => {
  it('keeps class + method signatures', () => {
    const lines: string[] = ['#include <vector>', '', 'class Engine {', 'public:']
    for (let m = 0; m < 5; m++) {
      lines.push(`  void step${m}(double dt) {`)
      for (let b = 0; b < 12; b++) lines.push(`    acc += dt * ${b};`)
      lines.push('  }')
    }
    lines.push('};')
    const input = lines.join('\n')
    const out = extractCodeStructure(input, 'cpp')
    expect(out.includes('void step0(double dt)')).toBe(true)
    expect(out.length).toBeLessThan(input.length)
  })
})
