:- consult(gato).
:- begin_tests(gato).
test(win_now) :- best_move(['O','O',e,'X','X',e,'X',e,e],2,10).
test(block_loss) :- best_move(['X','X',e,e,'O',e,e,e,e],2,_).
test(center) :- best_move(['X',e,e,e,e,e,e,e,e],4,0).
test(forced_draw) :- best_move(['X','O','X','X','O',e,'O','X',e],_,0).
% Exhaust every legal human continuation: optimal O never loses.
safe(B) :- winner(B,'O'), !.
safe(B) :- \+ member(e,B), !.
safe(B) :- forall(move(B,'X',_,N), (\+ winner(N,'X'),
    (\+ member(e,N) -> true ; best_move(N,I,_),move(N,'O',I,Next),safe(Next)))).
test(never_loses_all_human_paths) :- safe([e,e,e,e,e,e,e,e,e]).
test(easy_can_be_beaten) :-
    B=['O','O','X',e,'X',e,e,e,e], choose_move(B,easy,3,null,"reglas_basicas"),
    move(B,'O',3,N), move(N,'X',6,Win), winner(Win,'X').
test(easy_takes_immediate_win) :- choose_move(['O','O',e,'X','X',e,'X',e,e],easy,2,null,_).
test(medium_blocks_immediate_loss) :- choose_move(['X','X',e,e,'O',e,e,e,e],medium,2,null,_).
test(medium_prefers_own_win_to_block) :- choose_move(['O','O',e,'X','X',e,'X',e,e],medium,2,null,_).
test(hard_is_original_minimax) :- choose_move(['X',e,e,e,e,e,e,e,e],hard,4,0,"minimax").
:- end_tests(gato).
