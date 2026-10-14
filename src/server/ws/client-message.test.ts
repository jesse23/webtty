import { describe, expect, test } from 'bun:test';
import { type ClientMessage, clampSize, parseClientMessage, sizeFromQuery } from './client-message';

describe('clampSize', () => {
  test.each([
    [80, 24, 80, 24],
    [1, 1, 1, 1],
    [1000, 500, 1000, 500],
    [1001, 501, 1000, 500],
    [-5, -5, 1, 1],
    [0, 0, 80, 24],
    [Number.NaN, Number.NaN, 80, 24],
  ])('%p×%p → %p×%p', (cols, rows, wantCols, wantRows) => {
    expect(clampSize(cols, rows)).toEqual({ cols: wantCols, rows: wantRows });
  });
});

describe('sizeFromQuery', () => {
  test.each([
    ['', 80, 24],
    ['cols=120&rows=40', 120, 40],
    ['cols=120.9&rows=40x', 120, 40],
    ['cols=abc&rows=', 80, 24],
    ['cols=0&rows=0', 80, 24],
    ['cols=99999&rows=99999', 1000, 500],
    ['cols=-3&rows=-3', 1, 1],
  ])('?%s → %p×%p', (query, cols, rows) => {
    expect(sizeFromQuery(new URLSearchParams(query))).toEqual({ cols, rows });
  });
});

describe('parseClientMessage', () => {
  const controls: [string, ClientMessage][] = [
    ['{"type":"ack","chars":1234}', { type: 'ack', chars: 1234 }],
    ['{"type":"ack","chars":"77"}', { type: 'ack', chars: 77 }],
    ['{"type":"ack"}', { type: 'ack', chars: Number.NaN }],
    ['{"type":"resize","cols":100,"rows":30}', { type: 'resize', cols: 100, rows: 30 }],
    ['{"type":"resize","cols":100.7,"rows":30.2}', { type: 'resize', cols: 100, rows: 30 }],
    ['{"type":"resize","cols":0,"rows":0}', { type: 'resize', cols: 80, rows: 24 }],
    ['{"type":"resize"}', { type: 'resize', cols: 80, rows: 24 }],
    ['{"type":"resize","cols":5000,"rows":-1}', { type: 'resize', cols: 1000, rows: 1 }],
  ];

  test.each(controls)('%s is a control message', (frame, expected) => {
    expect(parseClientMessage(frame)).toEqual(expected);
  });

  test.each([
    ['plain keystrokes', 'ls -la\r'],
    ['an empty frame', ''],
    ['invalid JSON starting with {', '{ not json'],
    ['a { typed by the user', '{'],
    ['JSON with an unknown type', '{"type":"other"}'],
    ['JSON with no type', '{}'],
    ['JSON not starting with {', ' {"type":"ack","chars":1}'],
    ['a JSON array', '[{"type":"ack","chars":1}]'],
  ])('%s is raw input', (_name, frame) => {
    expect(parseClientMessage(frame)).toEqual({ type: 'input', data: frame });
  });
});
