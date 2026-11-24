import Foundation
import PDFKit
import Vision

struct PageText: Encodable {
    let page: Int
    let lines: [String]
    let captions: [String]
    let outputExamples: [String]
    let bodyLines: [String]?
    let tables: [PageTable]
    let literalReadbacks: [LiteralReadback]?
}

struct LiteralReadback: Encodable {
    let line: Int
    let original: String
    let alternate: String
}

func literalReadback(_ raw: String, box: CGRect, image: CGImage) -> (String, String)? {
    func capitals(_ value: String) -> [String] {
        value.matches(of: #/\b[A-Z]{3,}\b/#).map { String($0.output) }
    }
    let primary = capitals(raw)
    guard !primary.isEmpty, raw.unicodeScalars.allSatisfy({ !$0.properties.isIdeographic }) else { return nil }
    let region = box.insetBy(dx: -0.012, dy: -0.1 * box.height)
    let area = CGRect(x: region.minX * CGFloat(image.width), y: (1 - region.maxY) * CGFloat(image.height),
                      width: region.width * CGFloat(image.width), height: region.height * CGFloat(image.height))
    guard let strip = image.cropping(to: area.intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height)).integral) else {
        return nil
    }
    func read(_ correction: Bool) -> [String]? {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["en-US"]
        request.usesLanguageCorrection = correction
        guard (try? VNImageRequestHandler(cgImage: strip).perform([request])) != nil else { return nil }
        let rows = (request.results ?? []).filter { $0.boundingBox.width >= 0.7 && abs($0.boundingBox.midY - 0.5) <= 0.25 }
        guard rows.count == 1, let best = rows.first?.topCandidates(1).first, best.confidence >= 0.8 else { return nil }
        return capitals(best.string)
    }
    guard let alternate = read(false), alternate.count == primary.count, alternate != primary,
          alternate == read(true) else { return nil }
    let differences = zip(primary, alternate).filter { $0 != $1 }
    guard differences.count == 1, let (old, new) = differences.first,
          old.count == new.count, zip(old, new).filter({ $0 != $1 }).count == 1 else { return nil }
    return (old, new)
}

struct PageTable: Encodable {
    let caption: String
    let headings: [String]
    let rows: [[String]]
}

struct PrintedLine {
    let text: String
    let box: CGRect
}

func printedLines(_ page: PDFPage, in area: CGRect) -> [PrintedLine] {
    return (page.selection(for: area)?.selectionsByLine() ?? []).compactMap { selection in
        guard let text = selection.string?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty else { return nil }
        return PrintedLine(text: text, box: selection.bounds(for: page))
    }.sorted { $0.box.midY > $1.box.midY }
}

func cellText(_ lines: [PrintedLine]) -> String {
    lines.reduce("") { text, line in
        if text.isEmpty { return line.text }
        let han = text.last?.unicodeScalars.first?.properties.isIdeographic == true
        let nextHan = line.text.first?.unicodeScalars.first?.properties.isIdeographic == true
        return text + (han && nextHan ? "" : " ") + line.text
    }
}

func tableLayout(_ page: PDFPage, _ canvas: CGContext, _ bounds: CGRect, _ scale: CGFloat,
                 _ captions: [PrintedLine]) -> (body: [String]?, tables: [PageTable]) {
    guard !captions.isEmpty, let data = canvas.data else { return (nil, []) }
    let bytes = data.assumingMemoryBound(to: UInt8.self)
    let ink: (Int, Int) -> Bool = { x, y in
        let offset = (canvas.height - 1 - y) * canvas.bytesPerRow + 4 * x
        return bytes[offset] < 160 && bytes[offset + 1] < 160 && bytes[offset + 2] < 160
    }
    let pixelsY = { (y: CGFloat) in Int((y - bounds.minY) * scale) }
    let pixelsX = { (x: CGFloat) in Int((x - bounds.minX) * scale) }
    let pageY = { (y: Int) in CGFloat(y) / scale + bounds.minY }
    let pageX = { (x: Int) in CGFloat(x) / scale + bounds.minX }
    var regions: [CGRect] = []
    var tables: [PageTable] = []
    for (index, caption) in captions.enumerated() {
        // Booktabs and ruled tables both have a top rule and at least one full-width separator.
        let start = min(canvas.height - 1, pixelsY(caption.box.minY))
        let floor = max(0, pixelsY(index + 1 < captions.count ? captions[index + 1].box.maxY : bounds.minY))
        guard start > floor else { continue }
        var rules: [(y: Int, left: Int, right: Int)] = []
        for y in stride(from: start, through: floor, by: -1) {
            var left = 0
            for x in 0..<canvas.width where !ink(x, y) {
                if x - left >= canvas.width / 4 && (rules.last?.y ?? start + 10) - y > 2 {
                    rules.append((y, left, x))
                    break
                }
                left = x + 1
            }
        }
        guard let top = rules.first, start - top.y < Int(12 * scale) else { continue }
        let matching = rules.dropFirst().filter {
            abs($0.left - top.left) <= 3 && abs($0.right - top.right) <= 3
        }
        guard let header = matching.first, let bottom = matching.dropFirst().first else { continue }
        let headingHeight = pageY(top.y) - pageY(header.y)
        guard (10...55).contains(headingHeight) else { continue }
        let area = CGRect(x: pageX(top.left) - 1, y: pageY(bottom.y), width: pageX(top.right) - pageX(top.left) + 2,
                          height: pageY(top.y) - pageY(bottom.y))
        regions.append(area)
        // Locate each header cell from gaps in the rendered band, then read that column by rectangle.
        var starts: [Int] = []
        var last = top.left - Int(12 * scale)
        for x in max(0, pixelsX(area.minX))..<min(canvas.width, pixelsX(area.maxX)) {
            if ((header.y + 4)..<(top.y - 4)).contains(where: { ink(x, $0) }) {
                if x - last >= Int(11 * scale) { starts.append(x) }
                last = x
            }
        }
        guard (2...8).contains(starts.count), abs(starts[0] - top.left) < Int(12 * scale) else { continue }
        let edges = [area.minX] + starts.dropFirst().map { pageX($0) - 2 } + [min(area.maxX + 7, bounds.maxX)]
        var headings: [String] = []
        var columns: [[PrintedLine]] = []
        for (left, right) in zip(edges, edges.dropFirst()) {
            let column = CGRect(x: left, y: area.minY, width: right - left, height: area.height)
            headings.append(cellText(printedLines(page, in: column.intersection(
                CGRect(x: left, y: pageY(header.y), width: column.width, height: headingHeight)))))
            columns.append(printedLines(page, in: CGRect(x: left, y: area.minY,
                width: column.width, height: pageY(header.y) - area.minY)))
        }
        guard headings.allSatisfy({ !$0.isEmpty }), let leading = columns.first, !leading.isEmpty else { continue }
        let lineHeights = columns.flatMap { $0.map { $0.box.height } }.sorted()
        let height = lineHeights[lineHeights.count / 2]
        var rowTops: [CGFloat] = []
        var previousY = CGFloat.infinity
        for line in leading {
            if previousY - line.box.midY >= height * 1.57 {
                rowTops.append(line.box.midY + height * 0.28)
            }
            previousY = line.box.midY
        }
        guard let first = rowTops.first, columns.allSatisfy({ $0.first.map { $0.box.midY <= first } ?? false }) else { continue }
        let rows = zip(rowTops, rowTops.dropFirst() + [area.minY]).map { top, bottom in
            columns.map { cellText($0.filter { $0.box.midY <= top && $0.box.midY > bottom }) }
        }
        // A full row must retain one cell per header. Leave ambiguous tables in the PDF.
        guard rows.allSatisfy({ $0.allSatisfy { !$0.isEmpty } }) else { continue }
        tables.append(PageTable(caption: caption.text, headings: headings, rows: rows))
    }
    guard regions.count == captions.count else {
        // Without a dependable table boundary, the page remains available as an original and raw OCR.
        return ([], tables)
    }
    var body: [String] = []
    var previous: PrintedLine?
    for line in printedLines(page, in: bounds) {
        if regions.contains(where: { $0.minY < line.box.midY && $0.maxY > line.box.midY }) ||
            captions.contains(where: { abs($0.box.midY - line.box.midY) < 2 }) {
            if body.last != "" { body.append("") }
            previous = nil
            continue
        }
        if let prior = previous, prior.box.midY - line.box.midY > max(prior.box.height, line.box.height) * 1.7 {
            body.append("")
        }
        body.append(line.text)
        previous = line
    }
    return (body, tables)
}

func recognize(_ page: PDFPage, number: Int) throws -> PageText? {
    let bounds = page.bounds(for: .mediaBox)
    guard bounds.width.isFinite, bounds.height.isFinite, bounds.width > 0, bounds.height > 0 else { return nil }
    let scale = min(2.4, 2300 / max(bounds.width, bounds.height))
    guard let canvas = CGContext(data: nil, width: Int(ceil(bounds.width * scale)),
                                 height: Int(ceil(bounds.height * scale)), bitsPerComponent: 8, bytesPerRow: 0,
                                 space: CGColorSpaceCreateDeviceRGB(),
                                 bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    canvas.setFillColor(gray: 1, alpha: 1)
    canvas.fill(CGRect(x: 0, y: 0, width: canvas.width, height: canvas.height))
    canvas.scaleBy(x: scale, y: scale)
    canvas.translateBy(x: -bounds.minX, y: -bounds.minY)
    page.draw(with: .mediaBox, to: canvas)
    guard let image = canvas.makeImage() else { return nil }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    var literalReadbacks: [LiteralReadback] = []
    var lineNumber = 0
    let lines: [String] = (request.results ?? []).compactMap { observation in
        guard let text = observation.topCandidates(1).first, text.confidence >= 0.35 else { return nil }
        let label = text.string
        lineNumber += 1
        if let (old, new) = literalReadback(label, box: observation.boundingBox, image: image) {
            literalReadbacks.append(LiteralReadback(line: lineNumber, original: old, alternate: new))
        }
        guard ["开发完成日期", "首次发表日期"].contains(label) else { return label }
        // Vision can treat table labels and cells as different columns. Re-read just the cell to the right.
        let box = observation.boundingBox
        let region = CGRect(x: box.maxX, y: box.minY - 0.30 * box.height,
                            width: min(0.60, 0.99 - box.maxX), height: 1.60 * box.height)
        guard region.width > 0 else { return label }
        let area = CGRect(x: region.minX * CGFloat(image.width), y: (1 - region.maxY) * CGFloat(image.height),
                          width: region.width * CGFloat(image.width), height: region.height * CGFloat(image.height))
        guard let strip = image.cropping(to: area.integral) else { return label }
        let cell = VNRecognizeTextRequest()
        cell.recognitionLevel = .accurate
        cell.recognitionLanguages = request.recognitionLanguages
        cell.usesLanguageCorrection = false
        guard (try? VNImageRequestHandler(cgImage: strip).perform([cell])) != nil else { return label }
        let value = (cell.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined()
        guard let date = value.range(of: #"^\s*\d{4}\s*[-年./]\s*\d{1,2}\s*[-月./]\s*\d{1,2}\s*日?\s*$"#,
                                     options: .regularExpression) else { return label }
        return label + "：" + value[date].filter { !$0.isWhitespace }
    }
    let embedded = (page.string ?? "").components(separatedBy: .newlines)
    let captions = embedded.filter {
        $0.range(of: #"^\s*[表图]\s*[0-9]+(?:[.-][0-9]+)*\s*[:：]\s*\S"#,
                 options: .regularExpression) != nil
    }
    let outputExamples = embedded.filter {
        $0.range(of: #"^\s*[A-Z0-9_]+(?:-[A-Z0-9_]+)+\s+(?:(?:PASS|FAIL)\s+)?[A-Za-z_][\w.-]*=[+-]?\d+\s*$|^\s*[A-Z0-9_]+-BEGIN\s+\.\.\.\s+[A-Z0-9_]+-END\s*$"#,
                 options: .regularExpression) != nil
    }
    let tableCaption = #"^\s*表\s*[0-9]+(?:[.-][0-9]+)*\s*[:：]\s*\S"#
    let positioned = printedLines(page, in: bounds).filter {
        $0.text.range(of: tableCaption, options: .regularExpression) != nil
    }
    let layout = tableLayout(page, canvas, bounds, scale, positioned)
    let tableVisible = lines.contains { $0.range(of: tableCaption, options: .regularExpression) != nil }
    return PageText(page: number, lines: lines, captions: captions, outputExamples: outputExamples,
                    bodyLines: layout.body ?? (tableVisible ? [] : nil), tables: layout.tables,
                    literalReadbacks: literalReadbacks.isEmpty ? nil : literalReadbacks)
}

guard let document = PDFDocument(data: FileHandle.standardInput.readDataToEndOfFile()), !document.isLocked else {
    exit(1)
}
let results = CommandLine.arguments.dropFirst().compactMap { argument -> PageText? in
    guard let number = Int(argument), number > 0, let page = document.page(at: number - 1) else { return nil }
    return try? recognize(page, number: number)
}
FileHandle.standardOutput.write(try JSONEncoder().encode(results))
