"""Use an installed Argos en→zh package without contacting a service."""
import json
import sys
from pathlib import Path

import ctranslate2
import sentencepiece

directory = Path(sys.argv[1])
sp = sentencepiece.SentencePieceProcessor(model_file=str(directory / "sentencepiece.model"))
model = ctranslate2.Translator(str(directory / "model"), device="cpu", inter_threads=1, intra_threads=4)
texts = json.load(sys.stdin)
pieces = sp.encode(texts, out_type=str)
translated = model.translate_batch(pieces, beam_size=3, max_batch_size=256, batch_type="tokens",
                                   max_input_length=512, max_decoding_length=500)
json.dump([sp.decode(row.hypotheses[0]) for row in translated], sys.stdout, ensure_ascii=False)
