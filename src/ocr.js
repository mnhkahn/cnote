// Adapted from cyeam-cli/internal/visionocr; general text only.
ObjC.import('Foundation');
ObjC.import('Vision');
function run(argv) {
    var data = $.NSData.dataWithContentsOfFile(argv[0]);
    if (!data || !data.length) throw Error('Invalid image');
    var request = $.VNRecognizeTextRequest.alloc.init;
    request.recognitionLevel = 0;
    request.recognitionLanguages = $(['zh-Hans', 'en-US']);
    request.usesLanguageCorrection = false;
    request.minimumTextHeight = 0;
    var handler = $.VNImageRequestHandler.alloc.initWithDataOptions(data, $.NSDictionary.dictionary);
    if (!handler.performRequestsError($.NSArray.arrayWithObject(request), Ref())) throw Error('Vision failed');
    var lines = [];
    for (var i = 0; i < request.results.count; ++i) {
        var candidates = request.results.objectAtIndex(i).topCandidates(1);
        if (candidates.count) lines.push(ObjC.unwrap(candidates.objectAtIndex(0).string));
    }
    return JSON.stringify({text: lines.join('\n')});
}
